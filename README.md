# MedCare Hospital - appointments with live token queue

Full-stack website: Node.js backend + SQLite database + frontend, with **Patient, Doctor and Admin portals**.
**No npm install needed** - it uses only Node's built-in modules (requires **Node.js 22.5 or newer**).

## Run it
```
node server.js          # or: npm start
```
Open http://localhost:3000

Optional demo accounts (password `Password@123` for all): `npm run seed`
- admin@medcare.test, asha@medcare.test (doctor), rohan@medcare.test (doctor), priya@medcare.test (patient)

## Features
- Emergency number: red bar on every page + big call card on the home page (change it in Admin > Settings).
- Three portal cards at the bottom of the home page, each with Login and Register (email + password).
- Admin registration needs a code. Default is `MEDCARE-ADMIN` - set your own: `ADMIN_CODE=yourcode node server.js`.
- Doctors register, then an admin approves them before patients can see them.
- Booking: past dates are blocked (UI and server); up to 30 days ahead; limited tokens per doctor per day (doctor sets the limit).
- Approval flow: patient requests -> doctor approves/declines -> admin approves/rejects -> token number issued on admin approval.
- Live queue: home page and patient dashboard update instantly (Server-Sent Events) when the doctor presses "Call next".
  Patients see their token, tokens ahead, estimated wait, and the time to leave home (based on their travel time).

## Configuration (environment variables)
PORT (3000), ADMIN_CODE, JWT_SECRET (auto-generated into data/ if unset), DATA_DIR (default ./data).

## Files
server.js (API + static server), db.js (SQLite schema), auth.js (password hashing + sessions), seed.js, public/ (frontend).
Passwords are hashed with scrypt. For real patient data, put it behind HTTPS and back up the data/ folder.
