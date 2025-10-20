const fs = require('fs');
const path = require('path');
const DB = path.join(__dirname, 'memory.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return {}; }
}
function save(data) {
  fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

function getProfile(phone) {
  const db = load();
  return db[phone] || {};
}

function updateProfile(phone, patch) {
  const db = load();
  db[phone] = { ...(db[phone] || {}), ...patch, updatedAt: new Date().toISOString() };
  save(db);
  return db[phone];
}

module.exports = { getProfile, updateProfile };
