// whatsapp.js
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { runAgent } = require('./agent');
const { checkMember, logMessage } = require('./sheets');
const { transcribeBuffer } = require('./stt');
const mime = require('mime-types');

// === Configurar Chrome en macOS (opcional pero recomendado) ===
const chromePath =
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined;

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
  if (msg.fromMe) return true;                      // no responder mensajes propios
  if (msg.from === 'status@broadcast') return true; // ignorar estados
  if (isGroupJid(msg.from)) return true;            // ignorar grupos por ahora
  return false;
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(process.cwd(), '.wwebjs_auth'),
  }),
  puppeteer: {
    headless: true,
    // executablePath: chromePath, // si te da problemas, comentá esta línea
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 10_000,
});


// ====== Eventos base / diagnóstico ======
client.on('qr', (qr) => {
  console.log('📱 Escaneá este QR con el NÚMERO OFICIAL de ACIACAM:');
  qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Cargando WhatsApp Web: ${percent}% - ${message}`);
});

client.on('change_state', (state) => {
  console.log('🔁 Estado cliente:', state);
});

client.on('authenticated', () => {
  console.log('🔐 Sesión autenticada.');
});

client.on('auth_failure', (m) => {
  console.error('❌ Error de autenticación:', m);
});

client.on('ready', async () => {
  console.log('✅ WhatsApp conectado y listo.');
  try {
    const state = await client.getState();
    console.log('📟 Estado:', state);
  } catch (e) {
    console.log('📟 No pude obtener estado:', e?.message || e);
  }
});

client.on('disconnected', (reason) => {
  console.warn('⚠️ WhatsApp desconectado:', reason);
});

// (debug) muestra creación de mensajes (incluye los que enviás vos)
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
    } catch {
      // ignorar error de checkMember para no cortar el flujo
    }
    const tone = process.env.DEFAULT_TONE || 'amable';
    const intent = ''; // (cuando sumemos NLU, completamos)

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
      // LOG OUTBOUND de comando
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
      // loguear vacío por tracking
      await logMessage({
        direction: 'outbound',
        phone: from,
        reply: '',
        extra: {
          latency_ms: Date.now() - t0,
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
    } catch {
      // no-op
    }
    // ==== LOG ERROR ====
    try {
      await logMessage({
        direction: 'outbound',
        phone: msg.from.replace('@c.us', '').replace('@s.whatsapp.net', ''),
        reply: '',
        error: err?.message || 'handler error',
        extra: { wpp_to: msg.from, msg_id: msg.id?._serialized || '' },
      }).catch(() => {});
    } catch {
      // no-op
    }
  }
});

client.initialize();
