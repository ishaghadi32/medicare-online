'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, getSettings, setSetting } = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || 'MEDCARE-ADMIN';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BOOKING_DAYS = 30;

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => fmtDate(new Date());
function maxBookingDate() {
  const d = new Date();
  d.setDate(d.getDate() + MAX_BOOKING_DAYS);
  return fmtDate(d);
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+\-\s()]{6,20}$/;

// Statuses that use up one of the doctor's daily slots.
const ACTIVE = ['pending_doctor', 'pending_admin', 'approved', 'in_consultation', 'completed', 'no_show'];
const ACTIVE_SQL = ACTIVE.map((s) => `'${s}'`).join(',');

function publicUser(u) {
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    email: u.email,
    phone: u.phone,
    specialization: u.specialization,
    experience: u.experience,
    dailyLimit: u.daily_limit,
    status: u.status,
  };
}

function slotInfo(doctor, date) {
  const used = db
    .prepare(`SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ? AND date = ? AND status IN (${ACTIVE_SQL})`)
    .get(doctor.id, date).c;
  return { limit: doctor.daily_limit, used, remaining: Math.max(0, doctor.daily_limit - used) };
}

const APPT_SELECT = `
  SELECT a.*, p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone,
         d.name AS doctor_name, d.specialization AS doctor_specialization
  FROM appointments a
  JOIN users p ON p.id = a.patient_id
  JOIN users d ON d.id = a.doctor_id`;

function mapAppt(r, withLive = false) {
  const out = {
    id: r.id,
    date: r.date,
    reason: r.reason,
    status: r.status,
    token: r.token,
    doctorNote: r.doctor_note,
    adminNote: r.admin_note,
    createdAt: r.created_at,
    patient: { id: r.patient_id, name: r.patient_name, email: r.patient_email, phone: r.patient_phone },
    doctor: { id: r.doctor_id, name: r.doctor_name, specialization: r.doctor_specialization },
  };
  if (withLive) out.live = liveFor(r);
  return out;
}

// Live queue position for a patient's own appointment (only meaningful on the day itself).
function liveFor(a) {
  if (!a.token || a.date !== today() || !['approved', 'in_consultation'].includes(a.status)) return null;
  const avg = Number(getSettings().avg_minutes) || 10;
  const serving = db
    .prepare(`SELECT token FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'in_consultation'`)
    .get(a.doctor_id, a.date);
  const ahead = db
    .prepare(
      `SELECT COUNT(*) AS c FROM appointments
       WHERE doctor_id = ? AND date = ? AND status IN ('approved','in_consultation') AND token < ?`
    )
    .get(a.doctor_id, a.date, a.token).c;
  return {
    nowServing: serving ? serving.token : null,
    tokensAhead: ahead,
    estWaitMinutes: ahead * avg,
    yourTurn: a.status === 'in_consultation',
    avgMinutes: avg,
  };
}

// Snapshot of today's queue for every approved doctor (public, shown on the home page).
function boardSnapshot() {
  const date = today();
  const doctors = db
    .prepare(`SELECT id, name, specialization, daily_limit FROM users WHERE role = 'doctor' AND status = 'active' ORDER BY name`)
    .all();
  const settings = getSettings();
  return {
    date,
    avgMinutes: Number(settings.avg_minutes) || 10,
    doctors: doctors.map((d) => {
      const rows = db
        .prepare(`SELECT status, token FROM appointments WHERE doctor_id = ? AND date = ? AND token IS NOT NULL`)
        .all(d.id, date);
      const serving = rows.find((r) => r.status === 'in_consultation');
      return {
        id: d.id,
        name: d.name,
        specialization: d.specialization,
        nowServing: serving ? serving.token : null,
        tokensIssued: rows.length,
        waiting: rows.filter((r) => r.status === 'approved').length,
        seen: rows.filter((r) => r.status === 'completed' || r.status === 'no_show').length,
        slots: slotInfo(d, date),
      };
    }),
  };
}

// ---------------------------------------------------------------- live updates (Server-Sent Events)
const sseClients = new Set();
function broadcast() {
  if (!sseClients.size) return;
  const payload = `event: board\ndata: ${JSON.stringify(boardSnapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}
setInterval(() => {
  for (const res of sseClients) res.write(': keep-alive\n\n');
}, 25000).unref();

// ---------------------------------------------------------------- tiny rate limiter for auth endpoints
const hits = new Map();
function rateLimit(ip, limit = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (entry.count > limit) throw new HttpError(429, 'Too many attempts. Please try again in a few minutes.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60000).unref();

// ---------------------------------------------------------------- routes
const routes = [];
function route(method, pattern, roles, handler) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), '([^/]+)')) + '/?$'
  );
  routes.push({ method, re, keys, roles, handler });
}

// ---- public
route('GET', '/api/config', null, () => {
  const s = getSettings();
  return {
    hospitalName: s.hospital_name,
    emergencyNumber: s.emergency_number,
    emergencyNote: s.emergency_note,
    avgMinutes: Number(s.avg_minutes) || 10,
    today: today(),
    maxBookingDate: maxBookingDate(),
  };
});

route('GET', '/api/live', null, () => boardSnapshot());

route('GET', '/api/doctors', null, ({ query }) => {
  const date = isValidDate(query.date) ? query.date : null;
  const doctors = db
    .prepare(
      `SELECT id, name, specialization, experience, daily_limit FROM users
       WHERE role = 'doctor' AND status = 'active' ORDER BY name`
    )
    .all();
  return doctors.map((d) => ({
    id: d.id,
    name: d.name,
    specialization: d.specialization,
    experience: d.experience,
    slots: date ? slotInfo(d, date) : null,
  }));
});

// ---- auth
route('POST', '/api/auth/register', null, ({ body, ip }) => {
  rateLimit(ip);
  const role = body.role;
  if (!['patient', 'doctor', 'admin'].includes(role)) throw bad('Choose a valid portal.');
  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const phone = str(body.phone, 20);

  if (name.length < 2) throw bad('Please enter your full name.');
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email address.');
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  if (password.length > 128) throw bad('Password is too long.');
  if (phone && !PHONE_RE.test(phone)) throw bad('Please enter a valid phone number.');
  if (role === 'patient' && !phone) throw bad('Phone number is required for patients.');

  let specialization = null;
  let experience = null;
  let status = 'active';
  if (role === 'doctor') {
    specialization = str(body.specialization, 80);
    if (!specialization) throw bad('Please enter your specialization.');
    const exp = Number(body.experience);
    experience = Number.isFinite(exp) && exp >= 0 && exp <= 70 ? Math.round(exp) : 0;
    status = 'pending'; // an admin must approve doctor accounts
  }
  if (role === 'admin' && str(body.adminCode, 100) !== ADMIN_CODE) {
    throw new HttpError(403, 'Invalid admin registration code.');
  }

  const exists = db.prepare('SELECT id FROM users WHERE role = ? AND email = ?').get(role, email);
  if (exists) throw new HttpError(409, 'An account with this email already exists for this portal.');

  const info = db
    .prepare(
      `INSERT INTO users (role, name, email, phone, password_hash, specialization, experience, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(role, name, email, phone || null, auth.hashPassword(password), specialization, experience, status);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  if (role === 'doctor') broadcast();
  return { status: 201, data: { token: auth.signToken({ id: user.id, role: user.role }), user: publicUser(user) } };
});

route('POST', '/api/auth/login', null, ({ body, ip }) => {
  rateLimit(ip);
  const role = body.role;
  const email = str(body.email, 120).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!['patient', 'doctor', 'admin'].includes(role) || !email || !password) {
    throw bad('Email and password are required.');
  }
  const user = db.prepare('SELECT * FROM users WHERE role = ? AND email = ?').get(role, email);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Incorrect email or password.');
  }
  return { token: auth.signToken({ id: user.id, role: user.role }), user: publicUser(user) };
});

route('GET', '/api/auth/me', ['patient', 'doctor', 'admin'], ({ user }) => ({ user: publicUser(user) }));

// ---- patient
route('POST', '/api/appointments', ['patient'], ({ body, user }) => {
  const doctorId = Number(body.doctorId);
  const date = body.date;
  const reason = str(body.reason, 300);
  if (!isValidDate(date)) throw bad('Please choose a valid date.');
  if (date < today()) throw bad('You cannot book an appointment for a past date.');
  if (date > maxBookingDate()) throw bad(`Appointments can be booked up to ${MAX_BOOKING_DAYS} days ahead.`);
  if (reason.length < 3) throw bad('Please briefly describe the reason for your visit.');

  const created = tx(() => {
    const doctor = db
      .prepare(`SELECT * FROM users WHERE id = ? AND role = 'doctor' AND status = 'active'`)
      .get(doctorId);
    if (!doctor) throw bad('Selected doctor is not available.');
    const dup = db
      .prepare(
        `SELECT id FROM appointments WHERE patient_id = ? AND doctor_id = ? AND date = ? AND status IN (${ACTIVE_SQL})`
      )
      .get(user.id, doctorId, date);
    if (dup) throw new HttpError(409, 'You already have an appointment with this doctor on that date.');
    const { remaining } = slotInfo(doctor, date);
    if (remaining <= 0) throw new HttpError(409, 'All tokens for this doctor are booked on that date. Please pick another day.');
    const info = db
      .prepare(`INSERT INTO appointments (patient_id, doctor_id, date, reason) VALUES (?, ?, ?, ?)`)
      .run(user.id, doctorId, date, reason);
    return info.lastInsertRowid;
  });
  broadcast();
  return { status: 201, data: mapAppt(db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(created), true) };
});

route('GET', '/api/appointments/mine', ['patient'], ({ user }) => {
  const rows = db.prepare(`${APPT_SELECT} WHERE a.patient_id = ? ORDER BY a.date DESC, a.id DESC`).all(user.id);
  return rows.map((r) => mapAppt(r, true));
});

route('POST', '/api/appointments/:id/cancel', ['patient'], ({ params, user }) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND patient_id = ?').get(Number(params.id), user.id);
  if (!a) throw new HttpError(404, 'Appointment not found.');
  if (!['pending_doctor', 'pending_admin', 'approved'].includes(a.status)) {
    throw bad('This appointment can no longer be cancelled.');
  }
  db.prepare(`UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(a.id);
  broadcast();
  return { ok: true };
});

// ---- doctor
function requireActiveDoctor(user) {
  if (user.status !== 'active') throw new HttpError(403, 'Your doctor account is awaiting admin approval.');
}

route('GET', '/api/doctor/appointments', ['doctor'], ({ query, user }) => {
  const date = isValidDate(query.date) ? query.date : today();
  const rows = db
    .prepare(
      `${APPT_SELECT} WHERE a.doctor_id = ? AND a.date = ?
       ORDER BY CASE WHEN a.token IS NULL THEN 1 ELSE 0 END, a.token, a.id`
    )
    .all(user.id, date);
  return { date, today: today(), appointments: rows.map((r) => mapAppt(r)), slots: slotInfo(user, date) };
});

route('POST', '/api/doctor/appointments/:id/decision', ['doctor'], ({ params, body, user }) => {
  requireActiveDoctor(user);
  const decision = body.decision;
  const note = str(body.note, 300);
  if (!['approve', 'reject'].includes(decision)) throw bad('Decision must be approve or reject.');
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND doctor_id = ?').get(Number(params.id), user.id);
  if (!a) throw new HttpError(404, 'Appointment not found.');
  if (a.status !== 'pending_doctor') throw bad('This request has already been reviewed.');
  if (a.date < today()) throw bad('The date of this appointment has already passed.');
  const status = decision === 'approve' ? 'pending_admin' : 'rejected_by_doctor';
  db.prepare(`UPDATE appointments SET status = ?, doctor_note = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    note || null,
    a.id
  );
  broadcast();
  return { ok: true, status };
});

// Call the next token: finish the one in the room and bring in the next waiting patient.
route('POST', '/api/doctor/queue/next', ['doctor'], ({ user }) => {
  requireActiveDoctor(user);
  const date = today();
  const result = tx(() => {
    db.prepare(
      `UPDATE appointments SET status = 'completed', updated_at = datetime('now')
       WHERE doctor_id = ? AND date = ? AND status = 'in_consultation'`
    ).run(user.id, date);
    const next = db
      .prepare(
        `SELECT id, token FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'approved'
         ORDER BY token LIMIT 1`
      )
      .get(user.id, date);
    if (next) {
      db.prepare(`UPDATE appointments SET status = 'in_consultation', updated_at = datetime('now') WHERE id = ?`).run(next.id);
      return { nowServing: next.token };
    }
    return { nowServing: null };
  });
  broadcast();
  return result;
});

// Mark the patient currently being served (or a waiting one) as not present.
route('POST', '/api/doctor/appointments/:id/skip', ['doctor'], ({ params, user }) => {
  requireActiveDoctor(user);
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND doctor_id = ?').get(Number(params.id), user.id);
  if (!a) throw new HttpError(404, 'Appointment not found.');
  if (a.date !== today() || !['approved', 'in_consultation'].includes(a.status)) {
    throw bad('Only patients in today\'s queue can be marked as no-show.');
  }
  db.prepare(`UPDATE appointments SET status = 'no_show', updated_at = datetime('now') WHERE id = ?`).run(a.id);
  broadcast();
  return { ok: true };
});

route('PUT', '/api/doctor/profile', ['doctor'], ({ body, user }) => {
  const limit = Number(body.dailyLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('Daily token limit must be between 1 and 200.');
  const specialization = str(body.specialization, 80) || user.specialization;
  db.prepare('UPDATE users SET daily_limit = ?, specialization = ? WHERE id = ?').run(limit, specialization, user.id);
  broadcast();
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});

// ---- admin
route('GET', '/api/admin/stats', ['admin'], () => {
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;
  const t = today();
  return {
    patients: count(`SELECT COUNT(*) AS c FROM users WHERE role = 'patient'`),
    doctors: count(`SELECT COUNT(*) AS c FROM users WHERE role = 'doctor' AND status = 'active'`),
    pendingDoctors: count(`SELECT COUNT(*) AS c FROM users WHERE role = 'doctor' AND status = 'pending'`),
    awaitingAdmin: count(`SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending_admin'`),
    awaitingDoctor: count(`SELECT COUNT(*) AS c FROM appointments WHERE status = 'pending_doctor'`),
    todayApproved: count(
      `SELECT COUNT(*) AS c FROM appointments WHERE date = ? AND status IN ('approved','in_consultation','completed','no_show')`,
      t
    ),
    todayTotal: count(`SELECT COUNT(*) AS c FROM appointments WHERE date = ?`, t),
  };
});

route('GET', '/api/admin/appointments', ['admin'], ({ query }) => {
  const where = [];
  const args = [];
  if (query.status === 'needs_action') where.push(`a.status = 'pending_admin'`);
  else if (query.status === 'waiting_doctor') where.push(`a.status = 'pending_doctor'`);
  else if (query.status === 'approved') where.push(`a.status IN ('approved','in_consultation','completed','no_show')`);
  else if (query.status === 'rejected') where.push(`a.status IN ('rejected_by_doctor','rejected_by_admin','cancelled')`);
  if (isValidDate(query.date)) {
    where.push('a.date = ?');
    args.push(query.date);
  }
  const sql = `${APPT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.date DESC, a.id DESC LIMIT 300`;
  return db.prepare(sql).all(...args).map((r) => mapAppt(r));
});

route('POST', '/api/admin/appointments/:id/decision', ['admin'], ({ params, body }) => {
  const decision = body.decision;
  const note = str(body.note, 300);
  if (!['approve', 'reject'].includes(decision)) throw bad('Decision must be approve or reject.');

  const result = tx(() => {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(params.id));
    if (!a) throw new HttpError(404, 'Appointment not found.');
    if (!['pending_doctor', 'pending_admin'].includes(a.status)) throw bad('This appointment has already been decided.');

    if (decision === 'reject') {
      db.prepare(
        `UPDATE appointments SET status = 'rejected_by_admin', admin_note = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(note || null, a.id);
      return { status: 'rejected_by_admin', token: null };
    }
    if (a.status !== 'pending_admin') throw bad('The doctor has not approved this request yet.');
    if (a.date < today()) throw bad('The date of this appointment has already passed. Please reject it.');
    const max = db
      .prepare('SELECT COALESCE(MAX(token), 0) AS m FROM appointments WHERE doctor_id = ? AND date = ?')
      .get(a.doctor_id, a.date).m;
    const token = max + 1;
    db.prepare(
      `UPDATE appointments SET status = 'approved', token = ?, admin_note = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(token, note || null, a.id);
    return { status: 'approved', token };
  });
  broadcast();
  return { ok: true, ...result };
});

route('GET', '/api/admin/doctors', ['admin'], () => {
  return db
    .prepare(
      `SELECT id, name, email, phone, specialization, experience, daily_limit, status, created_at
       FROM users WHERE role = 'doctor' ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, name`
    )
    .all()
    .map((d) => ({ ...d, dailyLimit: d.daily_limit, createdAt: d.created_at }));
});

route('POST', '/api/admin/doctors/:id/decision', ['admin'], ({ params, body }) => {
  const decision = body.decision;
  if (!['approve', 'reject'].includes(decision)) throw bad('Decision must be approve or reject.');
  const d = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'doctor'`).get(Number(params.id));
  if (!d) throw new HttpError(404, 'Doctor not found.');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(decision === 'approve' ? 'active' : 'rejected', d.id);
  broadcast();
  return { ok: true };
});

route('GET', '/api/admin/settings', ['admin'], () => {
  const s = getSettings();
  return {
    hospitalName: s.hospital_name,
    emergencyNumber: s.emergency_number,
    emergencyNote: s.emergency_note,
    avgMinutes: Number(s.avg_minutes) || 10,
  };
});

route('PUT', '/api/admin/settings', ['admin'], ({ body }) => {
  const emergencyNumber = str(body.emergencyNumber, 20);
  const hospitalName = str(body.hospitalName, 80);
  const emergencyNote = str(body.emergencyNote, 120);
  const avg = Number(body.avgMinutes);
  if (!/^[0-9+\-\s()]{3,20}$/.test(emergencyNumber)) throw bad('Enter a valid emergency phone number.');
  if (hospitalName.length < 2) throw bad('Hospital name is required.');
  if (!Number.isInteger(avg) || avg < 1 || avg > 120) throw bad('Average minutes per patient must be 1-120.');
  setSetting('emergency_number', emergencyNumber);
  setSetting('hospital_name', hospitalName);
  setSetting('emergency_note', emergencyNote);
  setSetting('avg_minutes', avg);
  broadcast();
  return { ok: true };
});

// ---------------------------------------------------------------- HTTP plumbing
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
  );
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(bad('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function getUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = auth.verifyToken(token);
  if (!payload) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id) || null;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveStatic(req, res, pathname);
    }

    // Server-Sent Events stream for the live token board
    if (req.method === 'GET' && pathname === '/api/live/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: board\ndata: ${JSON.stringify(boardSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    let matched = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      matched = { r, m };
      break;
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed.' : 'Not found.');

    const { r, m } = matched;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

    let user = null;
    if (r.roles) {
      user = getUser(req);
      if (!user) throw new HttpError(401, 'Please log in to continue.');
      if (!r.roles.includes(user.role)) throw new HttpError(403, 'You do not have access to this section.');
    }

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const ip = req.socket.remoteAddress || 'unknown';
    const out = r.handler({ req, params, query, body, user, ip });
    if (out && out.status && out.data !== undefined) sendJson(res, out.status, out.data);
    else sendJson(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  }
});

server.listen(PORT, () => {
  console.log(`MedCare is running at http://localhost:${PORT}`);
  if (!process.env.ADMIN_CODE) {
    console.log(`Admin registration code (default): ${ADMIN_CODE}  - set ADMIN_CODE to change it.`);
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
