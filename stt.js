// stt.js
// Transcripción de audio con OpenAI + ffmpeg en Cloud Run

// Cargar .env SOLO si hace falta y sin romper si dotenv no está instalado
if (!process.env.OPENAI_API_KEY) {
  try { require('dotenv').config(); } catch (_) { /* no-op en Cloud Run */ }
}

const fs = require('fs');
const path = require('path');

// --- OpenAI SDK ---
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- ffmpeg portable (binarios empaquetados) ---
let ffmpegPath, ffprobePath, ffmpeg;
try {
  ffmpegPath = require('ffmpeg-static');
  ffprobePath = require('@ffprobe-installer/ffprobe').path;
  ffmpeg = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
} catch (e) {
  // Si falta alguna dependencia, dejamos un mensaje claro:
  console.warn('⚠️ ffmpeg no disponible. Instalá: ffmpeg-static fluent-ffmpeg @ffprobe-installer/ffprobe');
  // No lanzamos error acá: lo haremos cuando intenten convertir.
}

// --- Helpers de archivos temporales (Cloud Run solo permite escritura en /tmp) ---
const TMP_BASE = process.env.TMPDIR || '/tmp';

function ensureTmp() {
  const p = path.join(TMP_BASE, 'stt');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function guessExtFromMime(mime = '') {
  const m = (mime || '').toLowerCase();
  if (m.includes('wav')) return '.wav';
  if (m.includes('mp3')) return '.mp3';
  if (m.includes('m4a')) return '.m4a';
  if (m.includes('webm')) return '.webm';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('opus')) return '.opus';
  return '.ogg';
}

// Conversión con fluent-ffmpeg a WAV mono 16kHz (formato estable para STT)
async function ffmpegConvert(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) {
      return reject(new Error('ffmpeg no está disponible. Asegurate de instalar ffmpeg-static, fluent-ffmpeg y @ffprobe-installer/ffprobe'));
    }
    ffmpeg(inputPath)
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('error', (err) => reject(err))
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

// Transcribe un archivo (convierte a WAV 16k mono y manda a OpenAI)
async function transcribeFile(inputPath) {
  const tmp = ensureTmp();
  const base = path.basename(inputPath, path.extname(inputPath));
  const outWav = path.join(tmp, `${base}.wav`);

  await ffmpegConvert(inputPath, outWav);

  const resp = await openai.audio.transcriptions.create({
    // Podés cambiar a 'gpt-4o-mini-transcribe' si preferís el nuevo modelo
    model: 'whisper-1',
    file: fs.createReadStream(outWav),
    language: 'es', // ayuda para español
  });

  return { text: resp.text, outputPath: outWav };
}

/**
 * Transcribe un buffer de audio (contenido binario) con mime conocido.
 * Guarda archivo temporal en /tmp, convierte a WAV y llama a OpenAI.
 */
async function transcribeBuffer(buf, mime = 'audio/ogg') {
  const tmp = ensureTmp();
  const ext = guessExtFromMime(mime);
  const inPath = path.join(tmp, `in_${Date.now()}${ext}`);
  fs.writeFileSync(inPath, buf);

  try {
    const { text } = await transcribeFile(inPath);
    return text;
  } finally {
    // Limpieza best-effort (no lanzar error si falla)
    try { fs.unlinkSync(inPath); } catch (_) {}
    // El WAV convertido también se podría borrar si no lo querés conservar:
    // try { fs.unlinkSync(outWav); } catch (_) {}
  }
}

module.exports = { transcribeBuffer, transcribeFile };

