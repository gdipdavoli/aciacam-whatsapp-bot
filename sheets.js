// sheets.js
const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || 'Socios';
const LOGS_TAB = process.env.LOGS_TAB || 'Logs';
const LEADS_TAB = process.env.LEADS_TAB || 'Leads';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'aciacam-service-account.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// --- Helpers ---
const onlyDigits = (s = '') => String(s).replace(/\D/g, '');
function normalizePhoneAR(input = '') {
  // Acepta +54 9 2664..., 54 9..., 549..., 02664..., 2664..., etc.
  let d = onlyDigits(input);

  // quitar prefijos internacionales comunes
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9') && d.length >= 11) d = d.slice(1); // 9 intermedio de WhatsApp

  // ahora d queda tipo 2664XXXXXX o 261XXXXXXX, etc.
  return d;
}

// Cache simple en memoria
let cacheRows = null;
let cacheAt = 0;
function cacheValid() {
  return cacheRows && (Date.now() - cacheAt) < CACHE_TTL_MS;
}

async function getSheetsClient() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// Lee Socios con cache
async function readMembers() {
  if (cacheValid()) return cacheRows;

  const sheets = await getSheetsClient();
  const range = `${SHEET_TAB}!A2:C10000`; // A: Nombre, B: Teléfono, C: DNI (opcional)
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = resp.data.values || [];
  cacheRows = rows;
  cacheAt = Date.now();
  return rows;
}

// Coincidencia: por teléfono (terminación) o DNI (col C)
function matchMember(rows, phone, dni) {
  const p = normalizePhoneAR(phone);
  for (const row of rows) {
    const name = row[0]?.trim();
    const tel = normalizePhoneAR(row[1] || '');
    const doc = onlyDigits(row[2] || '');

    // match por terminación del teléfono (ej: endsWith 2664XXXX)
    if (tel && p.endsWith(tel)) return { isMember: true, name, phone: tel, dni: doc };

    // match por DNI exacto (si lo pasamos explícito)
    if (dni && doc && dni === doc) return { isMember: true, name, phone: tel, dni: doc };
  }
  return { isMember: false };
}

// --- API públicas ---
async function checkMember(phone, opts = {}) {
  // opts.dni si querés pasar DNI y usarlo como fallback
  try {
    if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID no configurado');
    const rows = await readMembers();
    const hit = matchMember(rows, phone, opts.dni);
    return hit;
  } catch (e) {
    console.error('Sheets checkMember error:', e.message);
    return { isMember: false, error: true };
  }
}

/* ===================== LOGS MEJORADOS ===================== */
// Asegura fila de cabeceras en LOGS_TAB
async function ensureLogsHeader() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID no configurado');
  const sheets = await getSheetsClient();

  const header = [
    'ts',           // ISO timestamp
    'direction',    // inbound|outbound
    'phone',
    'isMember',     // true|false
    'name',         // si socio
    'intent',       // opcional (si detectás intención)
    'tone',         // amable|formal|urgente
    'message',      // texto recibido (inbound) o enviado (outbound)
    'reply',        // respuesta del bot (si inbound)
    'error',        // errores
    'extra'         // JSON extra (latencia, ids, etc.)
  ];

  // Leer A1:K1; si está vacío, escribir cabeceras
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${LOGS_TAB}!A1:K1`
  }).catch(() => null);

  const hasHeader = !!(res && res.data && res.data.values && res.data.values[0]);
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LOGS_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] }
    });
  }
}

// Uso flexible: podés pasar sólo {phone, message}, o llenar todo.
async function logMessage({
  ts = new Date().toISOString(),
  direction = 'inbound', // inbound|outbound
  phone = '',
  isMember = '',
  name = '',
  intent = '',
  tone = '',
  message = '',
  reply = '',
  error = '',
  extra = {}
} = {}) {
  try {
    if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID no configurado');
    await ensureLogsHeader();

    const sheets = await getSheetsClient();
    const row = [
      ts,
      direction,
      String(phone),
      String(isMember),
      String(name || ''),
      String(intent || ''),
      String(tone || ''),
      String(message || ''),
      String(reply || ''),
      String(error || ''),
      JSON.stringify(extra || {})
    ];

    // Reintentos simples ante 429/50x
    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${LOGS_TAB}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [row] }
        });
        return { ok: true };
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr || new Error('No se pudo loguear');
  } catch (e) {
    console.warn('Sheets logMessage warn:', e.message);
    return { ok: false, error: e.message };
  }
}
/* =================== FIN LOGS MEJORADOS =================== */

async function logLead({ name = '', phone = '', topic = '', note = '' }) {
  try {
    if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID no configurado');
    const sheets = await getSheetsClient();
    const now = new Date().toISOString();
    const record = [now, name, phone, topic, note];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LEADS_TAB}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [record] }
    });
    return { ok: true };
  } catch (e) {
    console.warn('Sheets logLead warn:', e.message);
    return { ok: false };
  }
}

module.exports = { checkMember, logMessage, logLead, normalizePhoneAR };
