// server.js
// Cargar .env SOLO si hace falta y sin romper si dotenv no está instalado
if (!process.env.OPENAI_API_KEY) {
  try { require('dotenv').config(); } catch (_) { /* no-op en Cloud Run */ }
}

const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode'); // (lo seguís usando si quisieras renderizar en base64 en otro endpoint)
const app = express();

const { runAgent } = require('./agent');
const { checkMember, normalizePhoneAR, logMessage } = require('./sheets');
const { retrieve, dropIndex, ensureIndex } = require('./rag');

// === Meta Cloud API (WhatsApp) ===
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN; // token que elegís vos
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN;     // "Bearer ..." (Meta)
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;    // id del número de WhatsApp

app.use(express.json());

// ---- Manejo de errores no atrapados (para logs visibles) ----
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

// ===================================================================
// ---------------------- UTIL: ENVÍO VIA META ------------------------
// ===================================================================
async function sendWhatsAppText(to, body) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    console.warn('⚠️ Falta PHONE_NUMBER_ID o WHATSAPP_TOKEN para enviar por Meta');
    return;
  }
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: 'whatsapp', to, text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// Extraer texto de mensaje entrante de Meta
function extractIncomingText(msg) {
  if (!msg) return '';
  if (msg.type === 'text') return msg.text?.body || '';
  if (msg.type === 'interactive') {
    const i = msg.interactive || {};
    if (i.type === 'button_reply') return i.button_reply?.title || i.button_reply?.id || '';
    if (i.type === 'list_reply')   return i.list_reply?.title   || i.list_reply?.id   || '';
  }
  if (msg.type === 'image') return msg.image?.caption || '';
  return '';
}

// ===================================================================
// ---------------------- ESTADO / QR PARA WPPJS ----------------------
// ===================================================================

// ===== Estado compartido con whatsapp.js =====
let lastQrPng = null;
let clientState = 'BOOTING';
let logoutFn = async () => { throw new Error('logoutFn no configurado'); };

function setLastQr(buf) { lastQrPng = buf || null; console.log('🧩 setLastQr() size=', buf?.length || 0); }
function setClientState(st) { clientState = st || 'UNKNOWN'; console.log('🧩 setClientState()', clientState); }
function setLogoutFn(fn) { logoutFn = typeof fn === 'function' ? fn : logoutFn; console.log('🧩 setLogoutFn() listo'); }

// Endpoints de diagnóstico
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/state', (_req, res) => res.json({ state: clientState, hasQr: Boolean(lastQrPng) }));
app.get('/qr.png', (_req, res) => {
  if (!lastQrPng) return res.status(404).send('QR no disponible (conectado o aún no generado).');
  res.type('png').send(lastQrPng);
});
app.get('/qr-status', (_req, res) => res.json({ hasQr: !!lastQrPng, size: lastQrPng ? lastQrPng.length : 0 }));
app.post('/force-qr', async (_req, res) => {
  try { await logoutFn(); res.json({ ok: true, note: 'Logout realizado. Revisá /qr.png en unos segundos.' }); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || 'logout failed' }); }
});

// 👇 exportá ANTES de arrancar el server
module.exports = { setLastQr, setClientState, setLogoutFn };

// ===================================================================
// ---------------------- ENDPOINTS EXISTENTES ------------------------
// ===================================================================

// Enviar un mensaje de prueba al agente (no usa Meta ni QR)
app.post('/probar-mensaje', async (req, res) => {
  const { numero, mensaje, extra } = req.body || {};
  if (!numero || !mensaje) {
    return res.status(400).json({ error: 'Faltan numero o mensaje' });
  }

  const start = Date.now();
  try {
    // log inbound básico
    logMessage({
      direction: 'inbound',
      phone: String(numero),
      message: String(mensaje),
      extra
    }).catch(() => {});

    const reply = await runAgent({ phone: String(numero), text: String(mensaje) });

    // log outbound con reply + latencia
    logMessage({
      direction: 'outbound',
      phone: String(numero),
      reply: String(reply || ''),
      extra: { latency_ms: Date.now() - start }
    }).catch(() => {});

    return res.json({ respuesta: reply });
  } catch (e) {
    // log de error
    logMessage({
      direction: 'outbound',
      phone: String(numero),
      reply: '',
      error: e?.message || 'Fallo el agente',
      extra: { latency_ms: Date.now() - start }
    }).catch(() => {});
    console.error('Error agente:', e?.message || e);
    return res.status(500).json({ error: 'Fallo el agente' });
  }
});

// DEBUG: normalización de teléfono
app.get('/debug/phone/:n', (req, res) => {
  const input = req.params.n;
  const normalized = typeof normalizePhoneAR === 'function' ? normalizePhoneAR(input) : input;
  res.json({ input, normalized });
});

// DEBUG: verificación de socio en Sheets
app.get('/debug/check/:n', async (req, res) => {
  try {
    if (typeof checkMember !== 'function') {
      return res.status(500).json({ error: 'checkMember no disponible' });
    }
    const info = await checkMember(req.params.n);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Error en checkMember' });
  }
});

// DEBUG: RAG (consulta de contexto)
app.get('/debug/rag', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta query ?q=' });
  try {
    if (typeof retrieve !== 'function') {
      return res.status(500).json({ error: 'retrieve no disponible' });
    }
    const context = await retrieve(q);
    res.json({ query: q, context });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Error RAG' });
  }
});

// DEBUG: RAG (reindexar)
app.post('/debug/rag/reindex', async (_req, res) => {
  try {
    if (typeof dropIndex !== 'function' || typeof ensureIndex !== 'function') {
      return res.status(500).json({ ok: false, error: 'Funciones RAG no disponibles' });
    }
    dropIndex();
    const idx = await ensureIndex();
    res.json({ ok: true, chunks: idx.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Error reindex' });
  }
});

// ===================================================================
// ------------------- WEBHOOK DE META (opcional) ---------------------
// ===================================================================

// Verificación del webhook (GET) - Meta envía el challenge
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recepción de mensajes (POST)
app.post('/webhook', async (req, res) => {
  // Responder rápido a Meta para evitar reintentos
  res.sendStatus(200);

  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    const messages = value?.messages || [];
    for (const msg of messages) {
      const from = msg.from; // MSISDN (E.164 sin "+")
      const text = extractIncomingText(msg);
      if (!from || !text) continue;

      const start = Date.now();

      // Log inbound
      logMessage({
        direction: 'inbound',
        phone: from,
        message: text,
        extra: { meta_mid: msg.id }
      }).catch(() => {});

      // Ejecutar agente
      let reply = '';
      try {
        reply = await runAgent({ phone: from, text });
      } catch (e) {
        console.error('Error en runAgent:', e?.message || e);
      }

      // Enviar si hay respuesta
      if (reply && typeof reply === 'string') {
        try {
          await sendWhatsAppText(from, reply);
          // Log outbound
          logMessage({
            direction: 'outbound',
            phone: from,
            reply,
            extra: { latency_ms: Date.now() - start }
          }).catch(() => {});
        } catch (e) {
          console.error('Error enviando a WhatsApp:', e?.response?.data || e?.message || e);
          logMessage({
            direction: 'outbound',
            phone: from,
            reply,
            error: e?.message || 'fallo envio',
            extra: { latency_ms: Date.now() - start }
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('Error procesando webhook:', err?.response?.data || err?.message || err);
  }
});

// ===================================================================
// --- Health & root (antes del 404) ---
app.get('/', (_req, res) => res.status(200).send('ACIACAM bot OK'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// -------- 404 amigable ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada', path: req.originalUrl });
});

// -------- Arranque ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Servidor activo y escuchando en 0.0.0.0:${PORT}`);
  try {
    console.log('🚀 Iniciando cliente WhatsApp...');
    await require('./whatsapp');
  } catch (e) {
    console.error('❌ Error al iniciar WhatsApp:', e);
  }
});