// agent.js
const { retrieve } = require('./rag');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { checkMember, logLead } = require('./sheets'); // logLead es opcional si lo implementaste

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ---------- Utilidades de tono & prompt ---------- **/
function detectTone(userText) {
  const t = String(userText || '').toLowerCase();
  if (/(urgente|ahora|ya|por favor rápido|lo antes posible|apúrate|apurate)/.test(t)) {
    return 'urgente';
  }
  return process.env.DEFAULT_TONE || 'amable'; // amable | formal | urgente
}

function buildSystemPrompt({ isMember, name, tone }) {
  const basePath = path.join(__dirname, 'prompts', 'base.md');
  const base = fs.existsSync(basePath)
    ? fs.readFileSync(basePath, 'utf8')
    : `Rol: Asistente de ${process.env.ORG_NAME || 'ACIACAM'} (San Luis, AR).`;

  const toneBlock =
    tone === 'urgente'
      ? 'Tono: URGENTE. Respuestas breves, directas, pasos accionables.'
      : tone === 'formal'
      ? 'Tono: FORMAL. Sé correcto y completo.'
      : 'Tono: AMABLE. Cercano y claro.';

  const persona = isMember
    ? `Contexto del usuario: SOCIO${name ? ` (${name})` : ''}.`
    : `Contexto del usuario: INTERESADO.`;

  // Unas variables útiles que puede usar el modelo
  const vars = [
    `Organización: ${process.env.ORG_NAME || 'ACIACAM'}`,
    `Sede: ${process.env.SEDE_DIRECCION || 'Sede ACIACAM, San Luis'}`,
    `Cuota mensual: $${process.env.CUOTA_MENSUAL || '80000'}`,
  ].join('\n');

  return `${base}\n---\n${toneBlock}\n${persona}\n---\nVariables:\n${vars}`;
}

/** ---------- Reglas (fallback sin IA) ---------- **/
function respuestaReglada({ isMember, name, text }) {
  const sede = process.env.SEDE_DIRECCION || 'Sede ACIACAM';
  const cuota = process.env.CUOTA_MENSUAL || '80000';
  const org = process.env.ORG_NAME || 'ACIACAM';
  const msg = (text || '').toLowerCase();

  if (isMember) {
    if (/(retirar|retiro|pasar|sede)/.test(msg))
      return `¡Hola ${name || ''}! Podés retirar en la sede (${sede}). ¿Qué día te viene bien?`;
    if (/(envio|enviar|delivery|mandar)/.test(msg))
      return `¡Genial ${name || ''}! Decime tu barrio/localidad y coordinamos el envío y el costo.`;
    if (/(horario|cuando|día|dia)/.test(msg))
      return `Coordinemos: indicame un día aproximado y te paso opciones.`;
    return `¡Hola ${name || 'socia/o'}! ¿Querés coordinar retiro en sede o un envío? También respondo dudas rápidas.`;
  } else {
    if (/(cuota|pago|mensual)/.test(msg))
      return `La cuota social es de $${cuota}/mes. Si te interesa, te guiamos para asociarte.`;
    if (/(requisito|document|papel)/.test(msg))
      return `Requisitos: ser mayor de 18, DNI, y motivo terapéutico (te orientamos en el proceso).`;
    if (/(asociar|socios?|sumar|afiliar|inscribirme|formulario)/.test(msg))
      return `Para asociarte podés completar el formulario o acercarte a la sede (${sede}). ¿Querés que te pase el link?`;
    if (/(sede|direccion|dirección|donde|dónde)/.test(msg))
      return `Sede: ${sede}. Coordinamos horarios por este chat.`;
    return `Soy el asistente de ${org}. ¿Querés info sobre cómo asociarte, requisitos o la cuota social?`;
  }
}

/** ---------- (Opcional) detectar intención de lead ---------- **/
function isLeadIntent(text) {
  const t = String(text || '').toLowerCase();
  return /(asociar|hacerme socio|quiero ser socio|afiliar|inscribirme|formulario)/.test(t);
}

/** ---------- Agente principal ---------- **/
async function runAgent({ phone, text }) {
  // 1) Verificar socio en Sheets (si falla, tratamos como interesado)
  let socio = { isMember: false };
  try {
    socio = await checkMember(phone);
  } catch {
    socio = { isMember: false };
  }

  // 2) Construir prompt de sistema con tono dinámico
  const tone = detectTone(text);
  const system = buildSystemPrompt({ isMember: !!socio.isMember, name: socio.name, tone });
// 2.1) Recuperar contexto desde knowledge/ (RAG)
let context = '';
try {
  context = await retrieve(text); // top-k fragmentos relevantes
} catch (e) {
  console.warn('RAG retrieve warn:', e?.message || e);
}
  // 3) Intentar IA (OpenAI)
  try {
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
         { role: 'system', content: context ? `Contexto de conocimiento (útil para responder):\n${context}` : 'Sin contexto adicional.' },
        { role: 'user', content: text }
      ],
      temperature: tone === 'urgente' ? 0.1 : 0.3
    });

    const out = (r.choices?.[0]?.message?.content || '').trim();

    // Guardar lead si corresponde (best-effort)
    if (!socio.isMember && isLeadIntent(text) && typeof logLead === 'function') {
      try { await logLead({ name: '', phone, topic: 'Asociación', note: 'Lead detectado por intención' }); } catch {}
    }

    return out || respuestaReglada({ isMember: !!socio.isMember, name: socio.name, text });
  } catch (e) {
    // 4) Fallback a reglas en caso de error (incluye 429 insufficient_quota)
    console.warn('OpenAI fallback:', e?.message || e);
    if (!socio.isMember && isLeadIntent(text) && typeof logLead === 'function') {
      try { await logLead({ name: '', phone, topic: 'Asociación', note: 'Lead por fallback' }); } catch {}
    }
    return respuestaReglada({ isMember: !!socio.isMember, name: socio.name, text });
  }
}

module.exports = { runAgent };
