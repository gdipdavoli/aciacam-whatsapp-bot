// server.js
require('dotenv').config();

const express = require('express');
const app = express();

const { runAgent } = require('./agent');
const { checkMember, normalizePhoneAR, logMessage } = require('./sheets');
const { retrieve, dropIndex, ensureIndex } = require('./rag');

const PORT = process.env.PORT || 3000;

app.use(express.json());

// -------- Healthcheck ----------
// server.js (fragmento en /probar-mensaje)
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

// -------- DEBUG: normalización de teléfono ----------
app.get('/debug/phone/:n', (req, res) => {
  const input = req.params.n;
  const normalized = typeof normalizePhoneAR === 'function' ? normalizePhoneAR(input) : input;
  res.json({ input, normalized });
});

// -------- DEBUG: verificación de socio en Sheets ----------
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

// -------- DEBUG: RAG (consulta de contexto) ----------
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

// -------- DEBUG: RAG (reindexar) ----------
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

// -------- 404 amigable ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada', path: req.originalUrl });
});

// -------- Arranque ----------
app.listen(PORT, () => {
  console.log(`✅ Servidor activo en http://localhost:${PORT}`);
});
