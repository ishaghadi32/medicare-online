'use strict';
// Optional: creates demo accounts so you can try every portal immediately.  Run: npm run seed
const { db } = require('./db');
const { hashPassword } = require('./auth');

const PASSWORD = 'Password@123';
const accounts = [
  { role: 'admin', name: 'Hospital Admin', email: 'admin@medcare.test', phone: '9000000001' },
  { role: 'doctor', name: 'Dr. Asha Mehta', email: 'asha@medcare.test', phone: '9000000002', specialization: 'General Physician', experience: 12, status: 'active' },
  { role: 'doctor', name: 'Dr. Rohan Iyer', email: 'rohan@medcare.test', phone: '9000000003', specialization: 'Cardiologist', experience: 9, status: 'active' },
  { role: 'patient', name: 'Priya Sharma', email: 'priya@medcare.test', phone: '9000000004' },
];

const insert = db.prepare(
  `INSERT OR IGNORE INTO users (role, name, email, phone, password_hash, specialization, experience, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
for (const a of accounts) {
  insert.run(a.role, a.name, a.email, a.phone, hashPassword(PASSWORD), a.specialization || null, a.experience ?? null, a.status || 'active');
}
console.log('Demo accounts ready (password for all: ' + PASSWORD + '):');
for (const a of accounts) console.log(`  ${a.role.padEnd(8)} ${a.email}`);
