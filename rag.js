// rag.js
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INDEX_FILE = path.join(__dirname, 'knowledge.index.json');
const KNOW_DIR = path.join(__dirname, 'knowledge');

async function ensureIndex() {
  if (fs.existsSync(INDEX_FILE)) {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  }
  if (!fs.existsSync(KNOW_DIR)) fs.mkdirSync(KNOW_DIR);

  const files = fs.readdirSync(KNOW_DIR).filter(f => /\.(md|txt)$/i.test(f));
  const chunks = [];
  for (const file of files) {
    const full = path.join(KNOW_DIR, file);
    const raw = fs.readFileSync(full, 'utf8');
    const parts = raw.split(/\n{2,}/).map(t => t.trim()).filter(Boolean);
    for (const p of parts) {
      const piece = p.length > 2000 ? p.slice(0, 2000) : p;
      chunks.push({ file, text: piece });
    }
  }

  if (chunks.length === 0) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify([]));
    return [];
  }

  const inputs = chunks.map(c => c.text);
  const emb = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: inputs
  });

  const vectors = emb.data.map((d, i) => ({ ...chunks[i], embedding: d.embedding }));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(vectors, null, 2));
  return vectors;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] || 0, bi = b[i] || 0;
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function retrieve(question, k = 4) {
  const index = await ensureIndex();
  if (!index.length) return '';
  const qemb = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: question
  });
  const v = qemb.data[0].embedding;
  const scored = index.map(e => ({ ...e, score: cosine(v, e.embedding) }))
                      .sort((a,b)=>b.score-a.score)
                      .slice(0, k);
  return scored.map(s => `(${s.file}) ${s.text}`).join('\n---\n');
}

function dropIndex() {
  if (fs.existsSync(INDEX_FILE)) fs.unlinkSync(INDEX_FILE);
}

module.exports = { retrieve, dropIndex, ensureIndex };
