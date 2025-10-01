// stt.js
require('dotenv').config();

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function ensureTmp() {
  const p = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(p)) fs.mkdirSync(p);
  return p;
}

function ffmpegConvert(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', outputPath];
    const pr = spawn(ffmpegPath, args);
    let err = '';
    pr.stderr.on('data', d => (err += d.toString()));
    pr.on('close', code => {
      if (code === 0) return resolve(outputPath);
      reject(new Error(`ffmpeg exit ${code}: ${err}`));
    });
  });
}

async function transcribeFile(inputPath, preferred = 'mp3') {
  const tmp = ensureTmp();
  const out = path.join(tmp, `${path.basename(inputPath, path.extname(inputPath))}.${preferred}`);
  // Convertimos siempre para estandarizar
  await ffmpegConvert(inputPath, out);

  const resp = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file: fs.createReadStream(out),
    // language opcional (ayuda para español):
    language: 'es'
  });

  return { text: resp.text, outputPath: out };
}

/**
 * Transcribe un buffer de audio (base64 decodificado) con mime conocido.
 * Guarda archivo temporal, convierte y llama a Whisper.
 */
async function transcribeBuffer(buf, mime = 'audio/ogg') {
  const tmp = ensureTmp();
  // extensión tentativa
  const ext = mime.includes('wav') ? '.wav'
            : mime.includes('mp3') ? '.mp3'
            : mime.includes('m4a') ? '.m4a'
            : mime.includes('webm') ? '.webm'
            : '.ogg';
  const inPath = path.join(tmp, `in_${Date.now()}${ext}`);
  fs.writeFileSync(inPath, buf);
  const { text } = await transcribeFile(inPath, 'mp3');
  // Limpieza opcional: podés borrar los archivos si querés
  // fs.unlinkSync(inPath); fs.unlinkSync(outPath);
  return text;
}

module.exports = { transcribeBuffer };
