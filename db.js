'use strict';
// SQLite database using Node's built-in node:sqlite module (Node 22.5+). No npm packages needed.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'medcare.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  role           TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  specialization TEXT,
  experience     INTEGER,
  daily_limit    INTEGER NOT NULL DEFAULT 30,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','rejected')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (role, email)
);

CREATE TABLE IF NOT EXISTS appointments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES users(id),
  doctor_id   INTEGER NOT NULL REFERENCES users(id),
  date        TEXT NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending_doctor',
  token       INTEGER,
  doctor_note TEXT,
  admin_note  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_doctor_date ON appointments (doctor_id, date);
CREATE INDEX IF NOT EXISTS idx_appt_patient     ON appointments (patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_status      ON appointments (status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  hospital_name: 'MedCare Hospital',
  emergency_number: '108',
  emergency_note: 'Ambulance & emergency helpline - available 24 x 7',
  avg_minutes: '10', // average consultation time per token, used for wait estimates
};

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Run fn inside a transaction (node:sqlite has no helper for this).
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, tx, getSettings, setSetting, DATA_DIR };
