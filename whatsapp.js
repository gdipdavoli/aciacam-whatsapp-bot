// whatsapp.js
// whatsapp.js (modo CommonJS)
require('dotenv').config();

const puppeteer = require('puppeteer'); // <-- antes era "import"
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode');

const { runAgent } = require('./agent');
const { checkMember, logMessage } = require('./sheets');
const { transcribeBuffer } = require('./stt');

// setters del server para publicar QR/estado/forzar logout
let setLastQr = () => {};
let setClientState = () => {};
let setLogoutFn = async () => {};
try {
  ({ setLastQr, setClientState, setLogoutFn } = require('./server'));
} catch (_) { /* en tests/local puede no existir */ }

// --- Anti-duplicado (TTL) ---
const processed = new Set();
const TTL_MS = 5 * 60 * 1000; // 5 min
function markProcessed(key) {
  processed.add(key);
  setTimeout(() => processed.delete(key), TTL_MS);
}
function isGroupJid(jid = '') {
  return String(jid).endsWith('@g.us');
}
function isIgnorable(msg) {
  if (msg.fromMe) return true;
  if (msg.from === 'status@broadcast') return true;
  if (isGroupJid(msg.from)) return true;
  return false;
}

// ===== Conexión a Mongo y RemoteAuth =====
let store;
async function ensureStore() {
  if (!store) {
    // Conectar Mongoose (usa el pool interno y TLS de Atlas)
    await mongoose.connect(process.env.MONGO_URI, {
      // opcionales, pero ayudan en entornos serverless:
      autoIndex: false,
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 5,
    });
    // Pasar la instancia de Mongoose al store
    store = new MongoStore({ mongoose });
  }
  return store;
}

let client; // se inicializa dentro de la IIFE
(async () => {
  await ensureStore();
const fs = require('fs');
const CHROME_BIN = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium' || '/usr/bin/chromium-browser';

console.log('🧭 CHROME_BIN =', CHROME_BIN, 'exists?', fs.existsSync(CHROME_BIN));

client = new Client({
  authStrategy: new RemoteAuth({
    store,
    clientId: process.env.CLIENT_ID || 'aciacam-oficial',
    backupSyncIntervalMs: 300000,
  }),
  puppeteer: {
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    '/usr/bin/google-chrome-stable', // fallback

  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--single-process',
    '--disable-software-rasterizer',
    '--window-size=1920,1080',
  ],
},
takeoverOnConflict: true,
takeoverTimeoutMs: 10000,
});

  // ====== Eventos base / diagnóstico ======
  client.on('qr', async (qr) => {
  try {
    const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
    setLastQr(png);
    setClientState('QR_READY');
    console.log('🔐 QR generado. Bytes=', png?.length || 0, '→ disponible en /qr.png');
  } catch (e) {
    console.warn('No pude generar PNG de QR:', e?.message || e);
  }
});

  client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Cargando WhatsApp Web: ${percent}% - ${message}`);
  });

  client.on('change_state', (state) => {
    setClientState(state || 'UNKNOWN');
    console.log('🔁 Estado cliente:', state);
  });

  client.on('authenticated', () => {
    try { setLastQr(null); } catch {}
    setClientState('AUTHENTICATED');
    console.log('🔓 Sesión autenticada.');
  });

  client.on('auth_failure', (m) => {
    setClientState('AUTH_FAILURE');
    console.error('❌ Error de autenticación:', m);
  });

  client.on('ready', async () => {
    try { setLastQr(null); } catch {}
    const state = await client.getState().catch(()=>'READY');
    setClientState(state);
    console.log('✅ WhatsApp conectado y listo. 📟 Estado:', state);
  });

  client.on('disconnected', (reason) => {
    setClientState('DISCONNECTED');
    console.warn('⚠️ WhatsApp desconectado:', reason);
  });

  // (debug) muestra creación de mensajes
  client.on('message_create', (msg) => {
    console.log(`📝 message_create fromMe=${msg.fromMe} id=${msg.id?._serialized}`);
  });

  // ====== Handler principal ======
  client.on('message', async (msg) => {
    try {
      console.log(
        `📩 message: from=${msg.from} fromMe=${msg.fromMe} body="${(msg.body || '').slice(0, 80)}"`
      );
      if (isIgnorable(msg)) {
        console.log('↩️ ignorado (propio/estado/grupo)');
        return;
      }

      // Anti-duplicado por ID
      const key = msg.id?._serialized || `${msg.from}:${msg.timestamp}:${msg.body}`;
      if (processed.has(key)) {
        console.log('🔁 duplicado ignorado:', key);
        return;
      }
      markProcessed(key);

      const from = msg.from.replace('@c.us', '').replace('@s.whatsapp.net', '');
      const rawText = (msg.body || '').trim();
      const ts = new Date().toISOString();

      // ------ STT: transcribir si es audio ------
      let textOrTranscript = rawText;
      try {
        if (msg.hasMedia || msg.type === 'ptt' || msg.type === 'audio') {
          const media = await msg.downloadMedia(); // { data: base64, mimetype, filename }
          if (media && media.data && media.mimetype && media.mimetype.startsWith('audio/')) {
            const buf = Buffer.from(media.data, 'base64');
            const transcript = await transcribeBuffer(buf, media.mimetype);
            if (transcript && transcript.trim().length) {
              textOrTranscript = transcript.trim();
              console.log('🎧 Transcripción:', textOrTranscript);
            }
          }
        }
      } catch (e) {
        console.warn('STT warn:', e?.message || e);
      }

      // ==== LOG INBOUND ====
      let socio = { isMember: false, name: '' };
      try {
        socio = await checkMember(from);
      } catch { /* no cortar el flujo */ }

      const tone = process.env.DEFAULT_TONE || 'amable';
      const intent = '';

      await logMessage({
        ts,
        direction: 'inbound',
        phone: from,
        isMember: !!socio.isMember,
        name: socio.name || '',
        intent,
        tone,
        message: textOrTranscript,
        extra: {
          wpp_from: msg.from,
          msg_id: msg.id?._serialized || '',
          stt_from_audio: textOrTranscript !== rawText ? true : false,
        },
      }).catch(() => {});

      // Comando de salud
      if (/^!ping/i.test(textOrTranscript)) {
        await msg.reply('🏓 ¡Activo! El bot de ACIACAM está en línea.');
        await logMessage({
          direction: 'outbound',
          phone: from,
          reply: '🏓 ¡Activo! El bot de ACIACAM está en línea.',
          extra: { wpp_to: msg.from, msg_id: msg.id?._serialized || '' },
        }).catch(() => {});
        return;
      }

      // ==== Llamar al agente (IA + RAG + Sheets) ====
      const t0 = Date.now();
      const respuesta = await runAgent({ phone: from, text: textOrTranscript });

      // Responder (con o sin citar)
      const QUOTE = process.env.WHATSAPP_QUOTE_REPLY !== 'false';
      if (respuesta && respuesta.length) {
        if (QUOTE) {
          await msg.reply(respuesta); // cita el mensaje
        } else {
          await client.sendMessage(msg.from, respuesta); // sin cita
        }
        console.log('✅ respondido a', msg.from);

        // ==== LOG OUTBOUND ====
        await logMessage({
          direction: 'outbound',
          phone: from,
          reply: String(respuesta || ''),
          extra: {
            latency_ms: Date.now() - t0,
            wpp_to: msg.from,
            msg_id: msg.id?._serialized || '',
          },
        }).catch(() => {});
      } else {
        console.log('⚪ sin respuesta generada');
        await logMessage({
          direction: 'outbound',
          phone: from,
          reply: '',
          extra: {
            latency_ms: Date.now() - t0, // <- ojo: corregido abajo si te da error tipográfico
            wpp_to: msg.from,
            msg_id: msg.id?._serialized || '',
            note: 'no reply',
          },
        }).catch(() => {});
      }
    } catch (err) {
      console.error('💥 Error manejando mensaje:', err);
      try {
        await msg.reply('😕 Hubo un problema. Probá de nuevo en un momento.');
      } catch { /* no-op */ }

      // ==== LOG ERROR ====
      try {
        await logMessage({
          direction: 'outbound',
          phone: msg.from.replace('@c.us', '').replace('@s.whatsapp.net', ''),
          reply: '',
          error: err?.message || 'handler error',
          extra: { wpp_to: msg.from, msg_id: msg.id?._serialized || '' },
        }).catch(() => {});
      } catch { /* no-op */ }
    }
  });

  client.initialize();

  // permitir que server.js pueda forzar logout → nuevo QR
setLogoutFn(async () => {
    try {
      if (client && typeof client.logout === 'function') {
        await client.logout();
      } else if (client && typeof client.destroy === 'function') {
        await client.destroy();
      }
      setLastQr(null);
      setClientState('LOGGED_OUT');
    } catch (e) {
      console.warn('force-qr/logout warn:', e?.message || e);
      setClientState('LOGOUT_FAILED');
    }
  });
})();

