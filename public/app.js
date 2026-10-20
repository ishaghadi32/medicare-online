(() => {
  'use strict';

  // ------------------------------------------------------------ utilities
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICON = {
    cross: '<svg viewBox="0 0 24 24"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>',
    phone:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11.4 11.4 0 003.6.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.6a1 1 0 01-.25 1z"/></svg>',
    patient:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
    doctor:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v6a4 4 0 008 0V3"/><path d="M10 13v2a5 5 0 0010 0v-1.5"/><circle cx="20" cy="12" r="2"/></svg>',
    admin:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  };

  const ROLE_INFO = {
    patient: { label: 'Patient', blurb: 'Book appointments, get your token and track the queue live.' },
    doctor: { label: 'Doctor', blurb: 'Review appointment requests and run your daily token queue.' },
    admin: { label: 'Admin', blurb: 'Give final approval to appointments, manage doctors and settings.' },
  };

  const STATUS = {
    pending_doctor: ['Waiting for doctor', 'amber'],
    pending_admin: ['Doctor approved - awaiting admin', 'blue'],
    approved: ['Confirmed', 'green'],
    in_consultation: ['In consultation', 'teal'],
    completed: ['Completed', 'gray'],
    no_show: ['Missed', 'gray'],
    rejected_by_doctor: ['Declined by doctor', 'red'],
    rejected_by_admin: ['Rejected by admin', 'red'],
    cancelled: ['Cancelled', 'gray'],
  };
  const badge = (status) => {
    const [label, color] = STATUS[status] || [status, 'gray'];
    return `<span class="badge ${color}">${esc(label)}</span>`;
  };

  const fmtDay = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };
  const clockIn = (minutes) =>
    new Date(Date.now() + minutes * 60000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  const telHref = (n) => 'tel:' + String(n).replace(/[^\d+]/g, '');
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ------------------------------------------------------------ state & API
  const state = {
    config: { hospitalName: 'MedCare Hospital', emergencyNumber: '108', emergencyNote: '', avgMinutes: 10, today: localToday(), maxBookingDate: localToday() },
    token: localStorage.getItem('mc_token'),
    user: null,
    board: null,
    liveOn: false,
    routeId: 0,
    refresh: null,
    travel: Number(localStorage.getItem('mc_travel')) || 20,
    patient: { doctors: [], appts: [] },
    doctor: { date: null, appts: [], todayAppts: [], slots: null },
    admin: { tab: 'approvals', filter: 'all', date: '' },
  };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      if (res.status === 401 && state.token) {
        clearSession();
        toast('Your session has expired. Please log in again.', 'error');
        location.hash = '#/';
      }
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('mc_token', token);
  }
  function clearSession() {
    state.token = null;
    state.user = null;
    localStorage.removeItem('mc_token');
  }

  // ------------------------------------------------------------ toast & modal
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('#toast').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 4000);
  }

  function askNote({ title, text, confirmLabel = 'Confirm', danger = false, placeholder = 'Add a note (optional)' }) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      root.innerHTML = `
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <div class="modal">
            <h3 id="m-title">${esc(title)}</h3>
            <p class="muted small">${esc(text)}</p>
            <textarea id="m-note" maxlength="300" placeholder="${esc(placeholder)}"></textarea>
            <div class="actions">
              <button class="btn ghost" data-m="cancel" type="button">Cancel</button>
              <button class="btn ${danger ? 'danger' : ''}" data-m="ok" type="button">${esc(confirmLabel)}</button>
            </div>
          </div>
        </div>`;
      const done = (val) => {
        root.innerHTML = '';
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => e.key === 'Escape' && done(null);
      document.addEventListener('keydown', onKey);
      root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
        if (e.target.dataset.m === 'ok') done($('#m-note').value.trim());
        else if (e.target.dataset.m === 'cancel' || e.target.classList.contains('modal-backdrop')) done(null);
      });
      $('#m-note').focus();
    });
  }

  async function guarded(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ shared layout pieces
  function emergencyStrip() {
    const c = state.config;
    return `
      <div class="emergency-strip" role="region" aria-label="Emergency contact">
        <div class="container">
          <span>🚨 Emergency? Call now</span>
          <a class="call" href="${esc(telHref(c.emergencyNumber))}">${ICON.phone} ${esc(c.emergencyNumber)}</a>
          ${c.emergencyNote ? `<span class="em-note">${esc(c.emergencyNote)}</span>` : ''}
        </div>
      </div>`;
  }

  function brand() {
    return `<a class="brand" href="#/"><span class="brand-mark">${ICON.cross}</span><span>${esc(state.config.hospitalName)}</span></a>`;
  }

  function mount(html) {
    $('#app').innerHTML = emergencyStrip() + html;
    window.scrollTo(0, 0);
  }

  function dashBar() {
    const u = state.user;
    return `
      <div class="dash-bar">
        <div class="container">
          <div class="who">${brand()}<span class="role-pill">${esc(ROLE_INFO[u.role].label)} portal</span></div>
          <div class="who">
            <span class="small"><b>${esc(u.name)}</b> <span class="muted">${esc(u.email)}</span></span>
            <span class="live-badge ${state.liveOn ? '' : 'off'}" id="live-indicator"><i></i>${state.liveOn ? 'LIVE' : 'OFFLINE'}</span>
            <button class="btn ghost sm" data-action="logout">Log out</button>
          </div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ HOME
  function liveBoardHtml() {
    const b = state.board;
    if (!b) return '<div class="card empty">Loading live queue...</div>';
    if (!b.doctors.length) {
      return '<div class="card empty">No doctors are available yet. Please check back soon.</div>';
    }
    return `<div class="grid cols-3">${b.doctors
      .map(
        (d) => `
      <article class="card token-card">
        <div class="doc">${esc(d.name)}</div>
        <div class="spec">${esc(d.specialization || 'General')}</div>
        <div class="serving">
          <div class="cap">Now serving</div>
          ${d.nowServing ? `<div class="num">#${d.nowServing}</div>` : `<div class="num none">${d.seen ? 'Between patients' : 'Not started yet'}</div>`}
        </div>
        <div class="stats3">
          <div><b>${d.waiting}</b><span>waiting</span></div>
          <div><b>${d.seen}</b><span>seen</span></div>
          <div><b>${d.slots.remaining}</b><span>tokens left</span></div>
        </div>
      </article>`
      )
      .join('')}</div>`;
  }

  function renderHome() {
    const c = state.config;
    const dash = state.user
      ? `<a href="#/${state.user.role}">My dashboard</a><button class="linklike" data-action="logout">Log out</button>`
      : `<button class="linklike" data-action="scroll" data-target="portals">Login</button>`;
    const portal = (role, title) => `
      <article class="card portal-card ${role}">
        <div class="portal-icon">${ICON[role]}</div>
        <h3>${title}</h3>
        <p>${esc(ROLE_INFO[role].blurb)}</p>
        <div class="portal-actions">
          <a class="btn" href="#/auth/${role}/login">Login</a>
          <a class="btn secondary" href="#/auth/${role}/register">Register</a>
        </div>
      </article>`;

    mount(`
      <header class="site-header">
        <div class="container">
          ${brand()}
          <nav class="nav" aria-label="Main">
            <a class="hide-sm" href="#/" data-action="scroll" data-target="live">Live queue</a>
            <a class="hide-sm" href="#/" data-action="scroll" data-target="how">How it works</a>
            <a class="hide-sm" href="#/" data-action="scroll" data-target="portals">Portals</a>
            ${dash}
          </nav>
        </div>
      </header>
      <main id="main">
        <section class="hero">
          <div class="container hero-grid">
            <div>
              <span class="eyebrow">Smart hospital appointments</span>
              <h1>Book your visit. Skip the waiting room.</h1>
              <p class="lead">Request an appointment online, get a token number once it's approved, and watch the queue live - so you leave home exactly when it's your turn.</p>
              <div class="hero-cta">
                <a class="btn lg" href="#/auth/patient/register">Book an appointment</a>
                <button class="btn secondary lg" data-action="scroll" data-target="live">See live queue</button>
              </div>
            </div>
            <aside class="emergency-card" aria-label="Emergency helpline">
              <div class="label"><span class="pulse-ring"></span>Emergency helpline</div>
              <div class="number">${esc(c.emergencyNumber)}</div>
              <p class="muted small">${esc(c.emergencyNote || 'Available 24 x 7')}</p>
              <a class="btn danger block lg" href="${esc(telHref(c.emergencyNumber))}">${ICON.phone} Call emergency now</a>
            </aside>
          </div>
        </section>

        <section class="block" id="live">
          <div class="container">
            <div class="section-head">
              <h2>Live token status <span class="live-badge ${state.liveOn ? '' : 'off'}" id="live-indicator"><i></i>${state.liveOn ? 'LIVE' : 'CONNECTING'}</span></h2>
              <p>Today, ${esc(fmtDay(state.board ? state.board.date : c.today))}. Numbers update instantly as each doctor calls the next patient.</p>
            </div>
            <div id="live-board" aria-live="polite">${liveBoardHtml()}</div>
          </div>
        </section>

        <section class="block" id="how" style="padding-top:0">
          <div class="container">
            <div class="section-head"><h2>How it works</h2></div>
            <div class="grid cols-4 steps">
              <div class="card step"><h3>Register</h3><p>Create a free patient account with your email and password.</p></div>
              <div class="card step"><h3>Request a slot</h3><p>Pick a doctor and a date. Tokens are limited each day, so book early.</p></div>
              <div class="card step"><h3>Get approved</h3><p>The doctor reviews your request, then the admin confirms it and issues your token.</p></div>
              <div class="card step"><h3>Track &amp; arrive</h3><p>Follow the live queue from home and leave when your token is near.</p></div>
            </div>
          </div>
        </section>

        <section class="block portals" id="portals">
          <div class="container">
            <div class="section-head center" style="margin-inline:auto">
              <h2>Choose your portal</h2>
              <p style="margin-inline:auto">Each portal has its own secure login. New here? Register with your email and a password.</p>
            </div>
            <div class="grid portal-grid">
              ${portal('patient', 'Patient portal')}
              ${portal('doctor', 'Doctor portal')}
              ${portal('admin', 'Admin portal')}
            </div>
          </div>
        </section>
      </main>
      <footer class="site-footer">
        <div class="container">
          <div><b>${esc(c.hospitalName)}</b><br><span class="small">Appointments &amp; live queue management</span></div>
          <div>Emergency: <a href="${esc(telHref(c.emergencyNumber))}">${esc(c.emergencyNumber)}</a></div>
        </div>
      </footer>`);
    state.refresh = null;
  }

  // ------------------------------------------------------------ AUTH
  function renderAuth(role, mode) {
    if (!ROLE_INFO[role]) return (location.hash = '#/');
    if (state.user && state.user.role === role) return (location.hash = `#/${role}`);
    const reg = mode === 'register';
    const tabs = Object.keys(ROLE_INFO)
      .map((r) => `<a href="#/auth/${r}/${mode}" class="${r === role ? 'active' : ''}">${ROLE_INFO[r].label}</a>`)
      .join('');
    const extra =
      role === 'doctor'
        ? `<div class="row">
             <div class="field"><label for="f-spec">Specialization</label><input id="f-spec" name="specialization" required maxlength="80" placeholder="e.g. Cardiologist"></div>
             <div class="field"><label for="f-exp">Experience (years)</label><input id="f-exp" name="experience" type="number" min="0" max="70" value="0"></div>
           </div>
           <div class="alert info small">New doctor accounts are activated after an admin approves them.</div>`
        : role === 'admin'
        ? `<div class="field"><label for="f-code">Admin registration code</label><input id="f-code" name="adminCode" type="password" required autocomplete="off"><div class="hint">Provided by the hospital's system owner.</div></div>`
        : '';
    mount(`
      <main id="main" class="auth-wrap">
        <div class="auth-card">
          <div class="center" style="margin-bottom:1rem">${brand().replace('class="brand"', 'class="brand" style="justify-content:center"')}</div>
          <div class="card">
            <div class="role-tabs" role="tablist">${tabs}</div>
            <h2 style="font-size:1.5rem">${ROLE_INFO[role].label} ${reg ? 'registration' : 'login'}</h2>
            <p class="muted small">${esc(ROLE_INFO[role].blurb)}</p>
            <div id="form-error" class="form-error hidden" role="alert"></div>
            <form data-form="${reg ? 'register' : 'login'}" data-role="${role}" novalidate>
              ${reg ? `<div class="field"><label for="f-name">Full name</label><input id="f-name" name="name" required maxlength="80" autocomplete="name"></div>` : ''}
              <div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" required autocomplete="email" maxlength="120"></div>
              ${reg ? `<div class="field"><label for="f-phone">Phone ${role === 'patient' ? '' : '(optional)'}</label><input id="f-phone" name="phone" type="tel" ${role === 'patient' ? 'required' : ''} maxlength="20" autocomplete="tel"></div>` : ''}
              ${reg ? extra : ''}
              <div class="field"><label for="f-pass">Password</label><input id="f-pass" name="password" type="password" required minlength="8" autocomplete="${reg ? 'new-password' : 'current-password'}">${reg ? '<div class="hint">At least 8 characters.</div>' : ''}</div>
              ${reg ? `<div class="field"><label for="f-pass2">Confirm password</label><input id="f-pass2" name="password2" type="password" required autocomplete="new-password"></div>` : ''}
              <button class="btn block lg" type="submit">${reg ? 'Create account' : 'Log in'}</button>
            </form>
            <p class="mode-switch">${
              reg
                ? `Already registered? <a href="#/auth/${role}/login">Log in</a>`
                : `New here? <a href="#/auth/${role}/register">Create an account</a>`
            }</p>
          </div>
          <p class="center small"><a href="#/">← Back to home</a></p>
        </div>
      </main>`);
    state.refresh = null;
  }

  async function submitAuth(form) {
    const role = form.dataset.role;
    const mode = form.dataset.form;
    const data = Object.fromEntries(new FormData(form));
    const err = $('#form-error');
    const show = (m) => {
      err.textContent = m;
      err.classList.remove('hidden');
    };
    err.classList.add('hidden');
    if (!data.email || !data.password) return show('Please enter your email and password.');
    if (mode === 'register') {
      if (data.password.length < 8) return show('Password must be at least 8 characters.');
      if (data.password !== data.password2) return show('Passwords do not match.');
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const body = { ...data, role };
      delete body.password2;
      const res = await api('POST', mode === 'register' ? '/api/auth/register' : '/api/auth/login', body);
      setSession(res.token, res.user);
      toast(mode === 'register' ? 'Account created. Welcome!' : 'Welcome back, ' + res.user.name.split(' ')[0] + '!', 'success');
      location.hash = `#/${role}`;
    } catch (e) {
      show(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ PATIENT PORTAL
  function apptCardPatient(a) {
    const live = a.live;
    let livePanel = '';
    if (live) {
      if (live.yourTurn) {
        livePanel = `<div class="live-panel turn"><div class="big">🔔 It's your turn! Please go to ${esc(a.doctor.name)}'s room now.</div></div>`;
      } else {
        const travel = state.travel;
        const leave =
          live.estWaitMinutes <= travel
            ? '<b>Leave home now</b> - your turn is close.'
            : `Leave home at <b>${esc(clockIn(live.estWaitMinutes - travel))}</b> (in about ${live.estWaitMinutes - travel} min).`;
        livePanel = `
          <div class="live-panel" aria-live="polite">
            <div class="big">${live.nowServing ? `Now serving token #${live.nowServing}` : 'The doctor has not started calling tokens yet'}</div>
            <div class="live-grid">
              <div><b>#${a.token}</b><span>your token</span></div>
              <div><b>${live.tokensAhead}</b><span>ahead of you</span></div>
              <div><b>~${live.estWaitMinutes} min</b><span>estimated wait</span></div>
            </div>
            <p class="small" style="margin:.6rem 0 0">${leave} <span class="muted">(based on ${travel} min travel time and ${live.avgMinutes} min per patient)</span></p>
          </div>`;
      }
    }
    const cancellable = ['pending_doctor', 'pending_admin', 'approved'].includes(a.status);
    return `
      <article class="card appt">
        <div class="token-box ${a.token ? '' : 'none'}"><div class="cap">TOKEN</div><div class="num">${a.token ? '#' + a.token : '-'}</div></div>
        <div>
          <div class="appt-head"><h3 style="margin:0">${esc(a.doctor.name)} <span class="muted small" style="font-weight:500">${esc(a.doctor.specialization || '')}</span></h3>${badge(a.status)}</div>
          <div class="appt-meta">📅 ${esc(fmtDay(a.date))} · ${esc(a.reason || '')}</div>
          ${a.status === 'pending_doctor' ? '<div class="note">Waiting for the doctor to review your request.</div>' : ''}
          ${a.status === 'pending_admin' ? '<div class="note">The doctor approved. The admin will confirm shortly and your token will be issued.</div>' : ''}
          ${a.status === 'approved' && !live ? `<div class="note">Confirmed. Live queue tracking starts on ${esc(fmtDay(a.date))}.</div>` : ''}
          ${a.doctorNote ? `<div class="note"><b>Doctor's note:</b> ${esc(a.doctorNote)}</div>` : ''}
          ${a.adminNote ? `<div class="note"><b>Admin's note:</b> ${esc(a.adminNote)}</div>` : ''}
          ${livePanel}
          ${cancellable ? `<div class="appt-actions"><button class="btn ghost sm" data-action="cancel-appt" data-id="${a.id}">Cancel appointment</button></div>` : ''}
        </div>
      </article>`;
  }

  function renderPatientList() {
    const el = $('#appt-list');
    if (!el) return;
    const list = state.patient.appts;
    el.innerHTML = list.length
      ? list.map(apptCardPatient).join('')
      : '<div class="card empty">No appointments yet. Use the form to request your first one.</div>';
  }

  async function loadPatientAppts() {
    state.patient.appts = await api('GET', '/api/appointments/mine');
    renderPatientList();
  }

  function renderSlotInfo() {
    const sel = $('#book-doctor');
    const info = $('#slot-info');
    const btn = $('#book-btn');
    if (!sel || !info) return;
    const d = state.patient.doctors.find((x) => String(x.id) === sel.value);
    if (!d || !d.slots) {
      info.textContent = '';
      btn.disabled = !d;
      return;
    }
    const s = d.slots;
    info.innerHTML = s.remaining > 0
      ? `<span style="color:var(--green-700)">${s.remaining} of ${s.limit} tokens still available on this day.</span>`
      : `<span style="color:var(--red-dark)">All ${s.limit} tokens are booked for this day. Please choose another date.</span>`;
    btn.disabled = s.remaining <= 0;
  }

  async function loadDoctorsForDate() {
    const date = $('#book-date') ? $('#book-date').value : state.config.today;
    state.patient.doctors = await api('GET', `/api/doctors?date=${encodeURIComponent(date)}`);
    renderSlotInfo();
  }

  async function renderPatient(id) {
    const [cfg, appts, doctors] = await Promise.all([
      api('GET', '/api/config'),
      api('GET', '/api/appointments/mine'),
      api('GET', `/api/doctors?date=${state.config.today}`),
    ]);
    if (id !== state.routeId) return;
    state.config = { ...state.config, ...cfg };
    state.patient = { appts, doctors };
    mount(`
      ${dashBar()}
      <main id="main" class="dash container">
        <div class="split">
          <section class="card">
            <h2 style="font-size:1.35rem">Book an appointment</h2>
            ${
              doctors.length
                ? ''
                : '<div class="alert warn small">No doctors are available for booking yet. Please check back later.</div>'
            }
            <form data-form="book" novalidate>
              <div class="field"><label for="book-doctor">Doctor</label>
                <select id="book-doctor" name="doctorId" required>
                  ${doctors.map((d) => `<option value="${d.id}">${esc(d.name)} - ${esc(d.specialization || 'General')}</option>`).join('')}
                </select></div>
              <div class="field"><label for="book-date">Date</label>
                <input id="book-date" name="date" type="date" required min="${esc(state.config.today)}" max="${esc(state.config.maxBookingDate)}" value="${esc(state.config.today)}">
                <div class="hint">Past dates can't be selected. You can book up to 30 days ahead.</div>
                <div class="hint" id="slot-info" aria-live="polite"></div></div>
              <div class="field"><label for="book-reason">Reason for visit</label>
                <textarea id="book-reason" name="reason" required maxlength="300" placeholder="e.g. Fever and cough for 3 days"></textarea></div>
              <button class="btn block" id="book-btn" type="submit" ${doctors.length ? '' : 'disabled'}>Request appointment</button>
              <p class="hint">Your request goes to the doctor first, then the admin. Your token number is issued once the admin confirms.</p>
            </form>
          </section>
          <section>
            <div class="card" style="margin-bottom:1rem">
              <label for="travel">How long does it take you to reach the hospital? (minutes)</label>
              <input id="travel" type="number" min="0" max="240" value="${state.travel}" style="max-width:140px" data-input="travel">
              <div class="hint">We use this to tell you the best time to leave home on the day of your visit.</div>
            </div>
            <h2 style="font-size:1.35rem">My appointments</h2>
            <div id="appt-list"></div>
          </section>
        </div>
      </main>`);
    renderPatientList();
    renderSlotInfo();
    state.refresh = loadPatientAppts;
  }

  // ------------------------------------------------------------ DOCTOR PORTAL
  function queuePanelHtml() {
    const today = state.doctor.todayAppts;
    const serving = today.find((a) => a.status === 'in_consultation');
    const waiting = today.filter((a) => a.status === 'approved').length;
    const seen = today.filter((a) => ['completed', 'no_show'].includes(a.status)).length;
    const issued = today.filter((a) => a.token).length;
    const label = serving ? (waiting ? 'Finish & call next patient' : 'Finish consultation') : 'Call first patient';
    return `
      <div class="queue-hero">
        <div class="serving"><div class="cap">Now serving</div>${
          serving ? `<div class="num">#${serving.token}</div>` : '<div class="num none">Nobody yet</div>'
        }</div>
        <div>
          ${serving ? `<p style="margin:0 0 .6rem"><b>${esc(serving.patient.name)}</b> is in the room.</p>` : '<p class="muted" style="margin:0 0 .6rem">Press the button when you are ready for the next patient.</p>'}
          <div class="stats3" style="max-width:360px;text-align:left;margin-bottom:.9rem">
            <div><b>${waiting}</b><span>waiting</span></div><div><b>${seen}</b><span>seen</span></div><div><b>${issued}</b><span>tokens issued</span></div>
          </div>
          <div class="appt-actions" style="margin:0">
            <button class="btn lg" data-action="call-next" ${!serving && !waiting ? 'disabled' : ''}>${label}</button>
            ${serving ? `<button class="btn ghost" data-action="skip-appt" data-id="${serving.id}">Mark no-show</button>` : ''}
          </div>
        </div>
      </div>`;
  }

  function apptCardDoctor(a) {
    const t = state.config.today;
    const canReview = a.status === 'pending_doctor' && a.date >= t;
    const canSkip = a.date === t && a.status === 'approved';
    return `
      <article class="card appt">
        <div class="token-box ${a.token ? '' : 'none'}"><div class="cap">TOKEN</div><div class="num">${a.token ? '#' + a.token : '-'}</div></div>
        <div>
          <div class="appt-head"><h3 style="margin:0">${esc(a.patient.name)}</h3>${badge(a.status)}</div>
          <div class="appt-meta">📞 ${esc(a.patient.phone || 'No phone')} · ✉️ ${esc(a.patient.email)}<br>Reason: ${esc(a.reason || '')}</div>
          ${a.doctorNote ? `<div class="note"><b>Your note:</b> ${esc(a.doctorNote)}</div>` : ''}
          ${a.adminNote ? `<div class="note"><b>Admin's note:</b> ${esc(a.adminNote)}</div>` : ''}
          ${
            canReview
              ? `<div class="appt-actions">
                   <button class="btn sm" data-action="doc-decision" data-decision="approve" data-id="${a.id}">Approve</button>
                   <button class="btn danger sm" data-action="doc-decision" data-decision="reject" data-id="${a.id}">Decline</button>
                 </div>`
              : canSkip
              ? `<div class="appt-actions"><button class="btn ghost sm" data-action="skip-appt" data-id="${a.id}">Mark no-show</button></div>`
              : ''
          }
        </div>
      </article>`;
  }

  function renderDoctorParts() {
    const q = $('#queue-panel');
    if (q) q.innerHTML = queuePanelHtml();
    const l = $('#doc-appts');
    if (l) {
      const list = state.doctor.appts;
      l.innerHTML = list.length ? list.map(apptCardDoctor).join('') : '<div class="card empty">No appointments for this date.</div>';
    }
    const s = $('#doc-slots');
    if (s && state.doctor.slots) {
      s.textContent = `${state.doctor.slots.used} of ${state.doctor.slots.limit} daily tokens booked`;
    }
  }

  async function loadDoctorData() {
    const date = state.doctor.date || state.config.today;
    const main = await api('GET', `/api/doctor/appointments?date=${encodeURIComponent(date)}`);
    state.doctor.appts = main.appointments;
    state.doctor.slots = main.slots;
    state.config.today = main.today;
    if (date === main.today) state.doctor.todayAppts = main.appointments;
    else state.doctor.todayAppts = (await api('GET', `/api/doctor/appointments?date=${main.today}`)).appointments;
    renderDoctorParts();
  }

  async function renderDoctor(id) {
    state.doctor = { date: null, appts: [], todayAppts: [], slots: null };
    const cfg = await api('GET', '/api/config');
    if (id !== state.routeId) return;
    state.config = { ...state.config, ...cfg };
    state.doctor.date = cfg.today;
    const u = state.user;
    const active = u.status === 'active';
    mount(`
      ${dashBar()}
      <main id="main" class="dash container">
        ${
          u.status === 'pending'
            ? '<div class="alert warn"><b>Your account is awaiting admin approval.</b> You will be visible to patients and can manage appointments once approved.</div>'
            : u.status === 'rejected'
            ? '<div class="alert warn"><b>Your doctor account was not approved.</b> Please contact the hospital admin.</div>'
            : ''
        }
        ${active ? `<section class="card" style="margin-bottom:1.4rem"><h2 style="font-size:1.35rem">Today's queue <span class="muted small" style="font-weight:500">${esc(fmtDay(cfg.today))}</span></h2><div id="queue-panel"></div></section>` : ''}
        <div class="split">
          <section class="card">
            <h2 style="font-size:1.2rem">My settings</h2>
            <form data-form="doc-profile" novalidate>
              <div class="field"><label for="p-spec">Specialization</label><input id="p-spec" name="specialization" value="${esc(u.specialization || '')}" maxlength="80"></div>
              <div class="field"><label for="p-limit">Maximum tokens per day</label><input id="p-limit" name="dailyLimit" type="number" min="1" max="200" value="${u.dailyLimit}">
                <div class="hint">Patients can't book once this many tokens are taken for a day.</div></div>
              <button class="btn block" type="submit">Save settings</button>
            </form>
          </section>
          <section>
            <div class="toolbar">
              <div class="field"><label for="doc-date">Show appointments for</label><input id="doc-date" type="date" value="${esc(cfg.today)}" data-input="doc-date"></div>
              <div class="muted small" id="doc-slots"></div>
            </div>
            <div id="doc-appts"></div>
          </section>
        </div>
      </main>`);
    await loadDoctorData();
    state.refresh = loadDoctorData;
  }

  // ------------------------------------------------------------ ADMIN PORTAL
  function apptRowAdmin(a) {
    const canApprove = a.status === 'pending_admin';
    const canReject = ['pending_admin', 'pending_doctor'].includes(a.status);
    return `
      <tr>
        <td><b>${esc(a.patient.name)}</b><br><span class="muted small">${esc(a.patient.phone || '')}</span></td>
        <td>${esc(a.doctor.name)}<br><span class="muted small">${esc(a.doctor.specialization || '')}</span></td>
        <td>${esc(fmtDay(a.date))}</td>
        <td style="max-width:260px">${esc(a.reason || '')}
          ${a.doctorNote ? `<div class="note"><b>Doctor:</b> ${esc(a.doctorNote)}</div>` : ''}
          ${a.adminNote ? `<div class="note"><b>Admin:</b> ${esc(a.adminNote)}</div>` : ''}</td>
        <td>${badge(a.status)}</td>
        <td>${a.token ? '<b>#' + a.token + '</b>' : '-'}</td>
        <td><div class="appt-actions" style="margin:0">
          ${canApprove ? `<button class="btn sm" data-action="admin-decision" data-decision="approve" data-id="${a.id}">Approve</button>` : ''}
          ${canReject ? `<button class="btn danger sm" data-action="admin-decision" data-decision="reject" data-id="${a.id}">Reject</button>` : ''}
          ${a.status === 'pending_doctor' ? '<span class="muted small">Doctor has not approved yet</span>' : ''}
        </div></td>
      </tr>`;
  }
  const apptTable = (list, emptyMsg) =>
    list.length
      ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Patient</th><th>Doctor</th><th>Date</th><th>Reason / notes</th><th>Status</th><th>Token</th><th>Action</th></tr></thead><tbody>${list.map(apptRowAdmin).join('')}</tbody></table></div>`
      : `<div class="card empty">${esc(emptyMsg)}</div>`;

  async function adminTabHtml() {
    const tab = state.admin.tab;
    if (tab === 'approvals') {
      const [ready, waiting] = await Promise.all([
        api('GET', '/api/admin/appointments?status=needs_action'),
        api('GET', '/api/admin/appointments?status=waiting_doctor'),
      ]);
      return `
        <h3>Ready for your approval</h3>
        <p class="muted small">The doctor has approved these. Approving issues the patient's token number.</p>
        ${apptTable(ready, 'Nothing waiting for approval right now. 🎉')}
        <h3 style="margin-top:1.8rem">Still waiting for the doctor</h3>
        ${apptTable(waiting, 'No requests are waiting for a doctor.')}`;
    }
    if (tab === 'appointments') {
      const q = new URLSearchParams();
      if (state.admin.filter && state.admin.filter !== 'all') q.set('status', state.admin.filter);
      if (state.admin.date) q.set('date', state.admin.date);
      const list = await api('GET', '/api/admin/appointments?' + q.toString());
      const opt = (v, t) => `<option value="${v}" ${state.admin.filter === v ? 'selected' : ''}>${t}</option>`;
      return `
        <div class="toolbar">
          <div class="field"><label for="f-status">Status</label><select id="f-status" data-input="admin-filter">
            ${opt('all', 'All appointments')}${opt('needs_action', 'Needs admin approval')}${opt('waiting_doctor', 'Waiting for doctor')}${opt('approved', 'Approved / seen')}${opt('rejected', 'Rejected / cancelled')}</select></div>
          <div class="field"><label for="f-date">Date</label><input id="f-date" type="date" value="${esc(state.admin.date)}" data-input="admin-date"></div>
          ${state.admin.date ? '<button class="btn ghost sm" data-action="admin-clear-date">Clear date</button>' : ''}
        </div>
        ${apptTable(list, 'No appointments match these filters.')}`;
    }
    if (tab === 'doctors') {
      const list = await api('GET', '/api/admin/doctors');
      const label = { active: ['Approved', 'green'], pending: ['Pending approval', 'amber'], rejected: ['Rejected', 'red'] };
      return list.length
        ? `<div class="card table-wrap"><table class="data"><thead><tr><th>Doctor</th><th>Contact</th><th>Experience</th><th>Daily tokens</th><th>Status</th><th>Action</th></tr></thead><tbody>
            ${list
              .map(
                (d) => `<tr>
                  <td><b>${esc(d.name)}</b><br><span class="muted small">${esc(d.specialization || '')}</span></td>
                  <td>${esc(d.email)}<br><span class="muted small">${esc(d.phone || '')}</span></td>
                  <td>${d.experience ?? 0} yrs</td><td>${d.dailyLimit}</td>
                  <td><span class="badge ${label[d.status][1]}">${label[d.status][0]}</span></td>
                  <td><div class="appt-actions" style="margin:0">
                    ${d.status !== 'active' ? `<button class="btn sm" data-action="doctor-decision" data-decision="approve" data-id="${d.id}">Approve</button>` : ''}
                    ${d.status !== 'rejected' ? `<button class="btn danger sm" data-action="doctor-decision" data-decision="reject" data-id="${d.id}">${d.status === 'active' ? 'Deactivate' : 'Reject'}</button>` : ''}
                  </div></td></tr>`
              )
              .join('')}</tbody></table></div>`
        : '<div class="card empty">No doctors have registered yet.</div>';
    }
    // settings
    const s = await api('GET', '/api/admin/settings');
    return `
      <section class="card" style="max-width:560px">
        <h3>Hospital settings</h3>
        <form data-form="admin-settings" novalidate>
          <div class="field"><label for="s-name">Hospital name</label><input id="s-name" name="hospitalName" value="${esc(s.hospitalName)}" maxlength="80" required></div>
          <div class="row">
            <div class="field"><label for="s-em">Emergency number</label><input id="s-em" name="emergencyNumber" value="${esc(s.emergencyNumber)}" maxlength="20" required></div>
            <div class="field"><label for="s-avg">Avg. minutes per patient</label><input id="s-avg" name="avgMinutes" type="number" min="1" max="120" value="${s.avgMinutes}" required></div>
          </div>
          <div class="field"><label for="s-note">Emergency note</label><input id="s-note" name="emergencyNote" value="${esc(s.emergencyNote)}" maxlength="120"></div>
          <button class="btn" type="submit">Save settings</button>
          <p class="hint">The emergency number is shown on every page. The average time is used to estimate waiting times for patients.</p>
        </form>
      </section>`;
  }

  async function renderAdminTab() {
    const el = $('#admin-tab');
    if (!el) return;
    const html = await adminTabHtml();
    if ($('#admin-tab')) $('#admin-tab').innerHTML = html;
  }

  async function renderAdminStats() {
    const s = await api('GET', '/api/admin/stats');
    const el = $('#admin-stats');
    if (!el) return;
    el.innerHTML = `
      <div class="card stat hot"><b>${s.awaitingAdmin}</b><span>awaiting your approval</span></div>
      <div class="card stat"><b>${s.awaitingDoctor}</b><span>awaiting doctor</span></div>
      <div class="card stat"><b>${s.todayApproved}<small class="muted" style="font-size:1rem"> / ${s.todayTotal}</small></b><span>today's confirmed / total</span></div>
      <div class="card stat"><b>${s.doctors}</b><span>active doctors${s.pendingDoctors ? ` · <b style="color:var(--amber-700)">${s.pendingDoctors} pending</b>` : ''}</span></div>
      <div class="card stat"><b>${s.patients}</b><span>registered patients</span></div>`;
    const badgeEl = $('#tab-badge');
    if (badgeEl) badgeEl.innerHTML = s.awaitingAdmin ? `<span class="count">${s.awaitingAdmin}</span>` : '';
    const dBadge = $('#tab-badge-doc');
    if (dBadge) dBadge.innerHTML = s.pendingDoctors ? `<span class="count">${s.pendingDoctors}</span>` : '';
  }

  async function refreshAdmin() {
    await renderAdminStats();
    if (state.admin.tab !== 'settings') await renderAdminTab();
  }

  async function renderAdmin(id) {
    const cfg = await api('GET', '/api/config');
    if (id !== state.routeId) return;
    state.config = { ...state.config, ...cfg };
    const tab = (key, label, extra = '') =>
      `<button class="${state.admin.tab === key ? 'active' : ''}" data-action="admin-tab" data-tab="${key}">${label}${extra}</button>`;
    mount(`
      ${dashBar()}
      <main id="main" class="dash container">
        <div class="grid cols-4" id="admin-stats"></div>
        <div class="tabs" role="tablist">
          ${tab('approvals', 'Approvals', '<span id="tab-badge"></span>')}
          ${tab('appointments', 'All appointments')}
          ${tab('doctors', 'Doctors', '<span id="tab-badge-doc"></span>')}
          ${tab('settings', 'Settings')}
        </div>
        <div id="admin-tab"></div>
      </main>`);
    await Promise.all([renderAdminStats(), renderAdminTab()]);
    state.refresh = refreshAdmin;
  }

  // ------------------------------------------------------------ router
  async function route() {
    const id = ++state.routeId;
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
    state.refresh = null;
    try {
      if (!parts.length) return renderHome();
      if (parts[0] === 'auth') return renderAuth(parts[1], parts[2] === 'register' ? 'register' : 'login');
      const role = parts[0];
      if (['patient', 'doctor', 'admin'].includes(role)) {
        if (!state.user) return (location.hash = `#/auth/${role}/login`);
        if (state.user.role !== role) return (location.hash = `#/${state.user.role}`);
        if (role === 'patient') return await renderPatient(id);
        if (role === 'doctor') return await renderDoctor(id);
        return await renderAdmin(id);
      }
      location.hash = '#/';
    } catch (err) {
      if (id === state.routeId) {
        toast(err.message, 'error');
        if (!state.user) location.hash = '#/';
      }
    }
  }

  // ------------------------------------------------------------ live updates
  let refreshTimer = null;
  function onBoardUpdate() {
    const lb = $('#live-board');
    if (lb) lb.innerHTML = liveBoardHtml();
    if (state.refresh) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => state.refresh && state.refresh().catch(() => {}), 250);
    }
  }
  function setLive(on) {
    state.liveOn = on;
    document.querySelectorAll('#live-indicator').forEach((el) => {
      el.className = 'live-badge' + (on ? '' : ' off');
      el.innerHTML = `<i></i>${on ? 'LIVE' : 'RECONNECTING'}`;
    });
  }
  function connectLive() {
    const poll = async () => {
      try {
        state.board = await api('GET', '/api/live');
        onBoardUpdate();
      } catch {
        /* ignore */
      }
    };
    if (!('EventSource' in window)) {
      poll();
      setInterval(poll, 5000);
      return;
    }
    const es = new EventSource('/api/live/stream');
    es.addEventListener('board', (ev) => {
      state.board = JSON.parse(ev.data);
      setLive(true);
      onBoardUpdate();
    });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    setInterval(poll, 30000); // safety net
  }

  // ------------------------------------------------------------ actions (click delegation)
  const actions = {
    logout() {
      clearSession();
      toast('You have been logged out.');
      location.hash = '#/';
      route();
    },
    scroll(el, e) {
      const target = $('#' + el.dataset.target);
      if (!target) return;
      e.preventDefault();
      if (location.hash && location.hash !== '#/' && location.hash !== '#') {
        location.hash = '#/';
        setTimeout(() => $('#' + el.dataset.target)?.scrollIntoView({ behavior: 'smooth' }), 80);
      } else target.scrollIntoView({ behavior: 'smooth' });
    },
    async 'cancel-appt'(el) {
      const ok = await askNote({ title: 'Cancel this appointment?', text: 'This frees your token for another patient.', confirmLabel: 'Yes, cancel it', danger: true, placeholder: 'Reason (optional)' });
      if (ok === null) return;
      await guarded(el, async () => {
        await api('POST', `/api/appointments/${el.dataset.id}/cancel`);
        toast('Appointment cancelled.', 'success');
        await loadPatientAppts();
        await loadDoctorsForDate();
      });
    },
    async 'doc-decision'(el) {
      const approve = el.dataset.decision === 'approve';
      const note = await askNote({
        title: approve ? 'Approve this request?' : 'Decline this request?',
        text: approve ? 'It will go to the admin for final confirmation.' : 'The patient will be notified of your decision.',
        confirmLabel: approve ? 'Approve' : 'Decline',
        danger: !approve,
        placeholder: approve ? 'Note for the patient / admin (optional)' : 'Reason for declining (optional)',
      });
      if (note === null) return;
      await guarded(el, async () => {
        await api('POST', `/api/doctor/appointments/${el.dataset.id}/decision`, { decision: el.dataset.decision, note });
        toast(approve ? 'Approved - sent to admin for confirmation.' : 'Request declined.', 'success');
        await loadDoctorData();
      });
    },
    async 'call-next'(el) {
      await guarded(el, async () => {
        const r = await api('POST', '/api/doctor/queue/next');
        toast(r.nowServing ? `Now serving token #${r.nowServing}` : 'Queue is empty - all patients seen.', 'success');
        await loadDoctorData();
      });
    },
    async 'skip-appt'(el) {
      const ok = await askNote({ title: 'Mark as no-show?', text: 'Use this if the patient is not present. Their token will be skipped.', confirmLabel: 'Mark no-show', danger: true, placeholder: '' });
      if (ok === null) return;
      await guarded(el, async () => {
        await api('POST', `/api/doctor/appointments/${el.dataset.id}/skip`);
        toast('Marked as no-show.', 'success');
        await loadDoctorData();
      });
    },
    async 'admin-decision'(el) {
      const approve = el.dataset.decision === 'approve';
      let note = '';
      if (!approve) {
        note = await askNote({ title: 'Reject this appointment?', text: 'The patient will see your note.', confirmLabel: 'Reject', danger: true, placeholder: 'Reason for rejecting (optional)' });
        if (note === null) return;
      }
      await guarded(el, async () => {
        const r = await api('POST', `/api/admin/appointments/${el.dataset.id}/decision`, { decision: el.dataset.decision, note });
        toast(approve ? `Approved. Token #${r.token} issued to the patient.` : 'Appointment rejected.', 'success');
        await refreshAdmin();
      });
    },
    async 'doctor-decision'(el) {
      const approve = el.dataset.decision === 'approve';
      await guarded(el, async () => {
        await api('POST', `/api/admin/doctors/${el.dataset.id}/decision`, { decision: el.dataset.decision });
        toast(approve ? 'Doctor approved.' : 'Doctor rejected.', 'success');
        await refreshAdmin();
      });
    },
    async 'admin-tab'(el) {
      state.admin.tab = el.dataset.tab;
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === el));
      await guarded(null, renderAdminTab);
    },
    async 'admin-clear-date'() {
      state.admin.date = '';
      await guarded(null, renderAdminTab);
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el, e);
  });

  // ------------------------------------------------------------ forms
  const forms = {
    login: submitAuth,
    register: submitAuth,
    async book(form) {
      const btn = $('#book-btn');
      const data = Object.fromEntries(new FormData(form));
      await guarded(btn, async () => {
        const a = await api('POST', '/api/appointments', { doctorId: Number(data.doctorId), date: data.date, reason: data.reason });
        toast('Request sent! The doctor will review it, then the admin confirms and issues your token.', 'success');
        $('#book-reason').value = '';
        state.patient.appts.unshift(a);
        renderPatientList();
        await loadDoctorsForDate();
      });
    },
    async 'doc-profile'(form) {
      const data = Object.fromEntries(new FormData(form));
      await guarded(form.querySelector('button'), async () => {
        const r = await api('PUT', '/api/doctor/profile', { dailyLimit: Number(data.dailyLimit), specialization: data.specialization });
        state.user = r.user;
        toast('Settings saved.', 'success');
        await loadDoctorData();
      });
    },
    async 'admin-settings'(form) {
      const data = Object.fromEntries(new FormData(form));
      await guarded(form.querySelector('button'), async () => {
        await api('PUT', '/api/admin/settings', { ...data, avgMinutes: Number(data.avgMinutes) });
        state.config = { ...state.config, ...(await api('GET', '/api/config')) };
        const strip = $('.emergency-strip');
        if (strip) strip.outerHTML = emergencyStrip();
        toast('Settings saved.', 'success');
      });
    },
  };

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const fn = forms[form.dataset.form];
    if (fn) fn(form);
  });

  // inputs / selects that react immediately
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.input === 'travel') {
      state.travel = Math.max(0, Math.min(240, Number(t.value) || 0));
      localStorage.setItem('mc_travel', String(state.travel));
      renderPatientList();
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'book-doctor') renderSlotInfo();
    else if (t.id === 'book-date') {
      if (t.value && t.value < state.config.today) {
        t.value = state.config.today;
        toast("You can't book an appointment for a past date.", 'error');
      }
      await guarded(null, loadDoctorsForDate);
    } else if (t.dataset.input === 'doc-date') {
      state.doctor.date = t.value || state.config.today;
      await guarded(null, loadDoctorData);
    } else if (t.dataset.input === 'admin-filter') {
      state.admin.filter = t.value;
      await guarded(null, renderAdminTab);
    } else if (t.dataset.input === 'admin-date') {
      state.admin.date = t.value;
      await guarded(null, renderAdminTab);
    }
  });

  // ------------------------------------------------------------ boot
  async function boot() {
    try {
      state.config = { ...state.config, ...(await api('GET', '/api/config')) };
    } catch {
      /* keep defaults */
    }
    if (state.token) {
      try {
        state.user = (await api('GET', '/api/auth/me')).user;
      } catch {
        clearSession();
      }
    }
    try {
      state.board = await api('GET', '/api/live');
    } catch {
      /* ignore */
    }
    window.addEventListener('hashchange', route);
    connectLive();
    route();
  }
  boot();
})();
