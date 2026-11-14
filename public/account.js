// Optional host accounts: sign in, keep a room, "My rooms", take a room over on another device.
// Guests never see any of this. It appears only when the server has accounts enabled (CONFIG.auth).
// Mounts: #account-mount data-mode="landing"|"host" (a Sign in button / account chip in the page header, with a menu),
//         #account-mount data-mode="locked" (an inline notice on the "this browser did not start room X" page),
//         #keep-mount (the "Keep this room" toggle next to the room's own controls on the host page).
// Talks to /api/auth/* (proxied to the auth provider), /api/me, /api/me/rooms and /api/rooms/:code/host/claim.
// Sign-in methods come from CONFIG.authMethods (server env AUTH_METHODS): 'google' and/or 'email'.
(function () {
  'use strict';
  var C = window.CONFIG || {};
  if (!C.auth) return;
  var METHODS = Array.isArray(C.authMethods) ? C.authMethods : ['google'];
  var HAS_GOOGLE = METHODS.indexOf('google') >= 0, HAS_EMAIL = METHODS.indexOf('email') >= 0;
  var DAYS = 30;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  async function call(method, path, body, headers) {
    try {
      var r = await fetch(path, { method: method, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
      var data = null; try { data = await r.json(); } catch (e) { /* no body */ }
      return { ok: r.ok, status: r.status, data: data };
    } catch (e) { return { ok: false, status: 0, data: null }; }
  }
  var why = function (r, fallback) { return (r.data && (r.data.message || r.data.error)) || fallback; };
  var ago = function (t) { var m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 2 ? 'just now' : m < 120 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };

  // Coming back from "Continue with Google": the provider returns with a one-time verifier that is exchanged for a session
  // here, through this server, so the session cookie belongs to this site. It runs on every page load, whatever the page.
  var done = (async function () {
    var p = new URLSearchParams(location.search), v = p.get('neon_auth_session_verifier');
    if (!v) return;
    p.delete('neon_auth_session_verifier');
    try { history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : '') + location.hash); } catch (e) { /* ignore */ }
    await call('GET', '/api/auth/get-session?neon_auth_session_verifier=' + encodeURIComponent(v));
  })();

  // ---- shared state: who is signed in and which rooms they keep; every mount redraws when it changes ----
  var me = null, rooms = [], mounts = [], ready = false;
  async function refresh() {
    await done;
    var r = await call('GET', '/api/me'); me = r.ok && r.data ? r.data.user : null;
    if (me) { var q = await call('GET', '/api/me/rooms'); rooms = q.ok && q.data ? q.data.rooms || [] : []; } else rooms = [];
    ready = true; draw();
  }
  function draw() { mounts.forEach(function (m) { m.box.replaceChildren(); m.draw(m.box); }); }
  var firstName = function (u) { var n = String(u.name || '').trim().split(/\s+/)[0] || String(u.email || '?').split('@')[0]; return n.length > 12 ? n.slice(0, 11) + '…' : n; };

  // ---- dialogs: focus-trapped, Esc closes, click outside closes, focus returns to what opened it ----
  var openDlg = null;
  function closeDialog() { if (!openDlg) return; var d = openDlg; openDlg = null; d.root.remove(); document.removeEventListener('keydown', d.key, true); if (d.opener && d.opener.isConnected) d.opener.focus(); if (d.opener) d.opener.setAttribute('aria-expanded', 'false'); }
  // kind 'modal' is centred over a dim backdrop; 'menu' hangs under the opener, right-aligned.
  function dialog(opener, kind, title, fill) {
    closeDialog();
    var root = el('div', 'acct-layer ' + kind), panel = el('div', 'acct-panel'), id = 'acct-t-' + Math.random().toString(36).slice(2, 7);
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', id); panel.tabIndex = -1;
    var head = el('div', 'acct-head'), h = el('h2', null, title); h.id = id;
    var x = el('button', 'acct-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closeDialog);
    head.append(h, x); panel.append(head); fill(panel); root.append(panel); document.body.appendChild(root);
    if (opener) opener.setAttribute('aria-expanded', 'true');
    if (kind === 'menu' && opener) { var r = opener.getBoundingClientRect(); panel.style.top = Math.round(r.bottom + 8) + 'px'; panel.style.right = Math.max(16, Math.round(window.innerWidth - r.right)) + 'px'; }
    root.addEventListener('mousedown', function (e) { if (e.target === root) closeDialog(); });
    var key = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(panel.querySelectorAll('button, input, a[href], [tabindex="0"]'), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (!panel.contains(a)) { e.preventDefault(); first.focus(); } else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key, true);
    openDlg = { root: root, key: key, opener: opener };
    var firstField = panel.querySelector('input, .acct-main button') || panel.querySelector('button:not(.acct-x)') || panel; firstField.focus();
    return panel;
  }

  // ---- sign-in methods ----
  function googleButton(status) {
    var g = el('button', 'btn acct-method', 'Continue with Google'); g.type = 'button';
    g.addEventListener('click', async function () {
      g.disabled = true; status.textContent = 'Opening Google…';
      var r = await call('POST', '/api/auth/sign-in/social', { provider: 'google', callbackURL: location.origin + location.pathname + location.search });
      if (r.ok && r.data && r.data.url) { location.href = r.data.url; return; }
      g.disabled = false; status.textContent = why(r, 'Google sign-in is not available right now.');
    });
    return g;
  }
  function emailForm(onDone) {
    var creating = false, busy = false;
    var form = el('form', 'acct-form'); form.noValidate = true;
    var tabs = el('div', 'acct-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Email sign in');
    var tIn = el('button', 'acct-tab', 'Sign in'), tUp = el('button', 'acct-tab', 'Create account'); tIn.type = tUp.type = 'button';
    tabs.append(tIn, tUp);
    var eL = el('label', null, 'Email'), email = el('input'); email.type = 'email'; email.name = 'email'; email.id = 'acct-email'; email.autocomplete = 'email'; email.required = true; eL.htmlFor = email.id;
    var pL = el('label', null, 'Password'), pass = el('input'); pass.type = 'password'; pass.name = 'password'; pass.id = 'acct-pass'; pass.required = true; pL.htmlFor = pass.id;
    var err = el('p', 'acct-err'); err.setAttribute('role', 'alert');
    var go = el('button', 'btn primary acct-go'); go.type = 'submit';
    var info = el('p', 'acct-confirm'); info.setAttribute('role', 'status'); info.hidden = true;
    function mode(c) {
      creating = c; tIn.setAttribute('aria-pressed', String(!c)); tUp.setAttribute('aria-pressed', String(c));
      tIn.classList.toggle('on', !c); tUp.classList.toggle('on', c); go.textContent = c ? 'Create account' : 'Sign in';
      pass.autocomplete = c ? 'new-password' : 'current-password'; err.textContent = '';
    }
    tIn.addEventListener('click', function () { mode(false); }); tUp.addEventListener('click', function () { mode(true); });
    mode(false);
    form.append(tabs, eL, email, pL, pass, err, go);
    var wrap = el('div'); wrap.append(form, info);
    form.addEventListener('submit', async function (e) {
      e.preventDefault(); if (busy) return;
      var em = email.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(em)) { err.textContent = 'Enter a valid email address.'; email.focus(); return; }
      if (!pass.value) { err.textContent = 'Enter a password.'; pass.focus(); return; }
      busy = true; go.disabled = true; err.textContent = ''; go.textContent = creating ? 'Creating account…' : 'Signing in…';
      var body = { email: em, password: pass.value }; if (creating) body.name = em.split('@')[0];
      var r = await call('POST', '/api/auth/' + (creating ? 'sign-up/email' : 'sign-in/email'), body);
      busy = false; go.disabled = false; mode(creating);
      if (!r.ok) { err.textContent = why(r, creating ? 'Could not create the account.' : 'Wrong email or password.'); return; }
      await refresh();
      if (me) { onDone(); return; }
      form.hidden = true; info.hidden = false; info.replaceChildren(el('strong', null, 'Check your email'), el('span', null, ' We sent a link to ' + em + '. Open it to confirm your address, then come back and sign in.'));
      var back = el('button', 'btn small', 'Back to sign in'); back.type = 'button'; back.addEventListener('click', function () { info.hidden = true; form.hidden = false; mode(false); email.focus(); });
      info.append(el('br'), back);
    });
    return wrap;
  }
  function methods(context, onDone) {
    var box = el('div', 'acct-methods'), status = el('p', 'hint'); status.setAttribute('role', 'status');
    if (!HAS_GOOGLE && !HAS_EMAIL) { box.append(el('p', 'hint', 'Sign-in is not set up on this server yet.')); return box; }
    if (HAS_GOOGLE) box.append(googleButton(status));
    if (HAS_GOOGLE && HAS_EMAIL) box.append(el('p', 'hint acct-or', 'or use your email'));
    if (HAS_EMAIL) box.append(emailForm(onDone));
    box.append(status); return box;
  }
  function signInDialog(opener, title) {
    return dialog(opener, 'modal', title || 'Sign in', function (panel) {
      var why1 = el('p', 'hint acct-why', 'Optional. Sign in to keep rooms for ' + DAYS + ' days and open them on any device. Guests never need an account.');
      panel.append(why1, methods(title, closeDialog));
    });
  }

  // ---- header control: "Sign in" button, or a chip with a menu ----
  async function reclaim(code, status) {
    var r = await call('POST', '/api/me/rooms/' + code + '/reclaim', {});
    if (!r.ok || !r.data || !r.data.hostKey) { status.textContent = why(r, 'Could not open that room.'); return; }
    lsSet('rb-host-' + code, r.data.hostKey);
    location.href = '/host/' + code;
  }
  function menu(opener, here) {
    dialog(opener, 'menu', 'Your account', function (panel) {
      panel.append(el('p', 'hint acct-who', 'Signed in as ' + (me.email || me.name)));
      panel.append(el('h3', 'acct-sub', 'My rooms'));
      var status = el('p', 'hint acct-err'); status.setAttribute('role', 'status');
      var list = el('ul', 'account-rooms');
      if (!rooms.length) list.append(el('li', 'hint', 'No kept rooms yet. Open a room and choose “Keep this room”.'));
      rooms.forEach(function (r) {
        var li = el('li'), t = el('span', 'acct-room'); t.append(el('b', null, r.name || 'Room ' + r.code), el('small', null, r.code + ' · used ' + ago(r.touchedAt)));
        li.append(t);
        if (r.code === here) li.append(el('span', 'acct-here', 'This room'));
        else { var open = el('button', 'btn small', 'Open'); open.type = 'button'; open.setAttribute('aria-label', 'Open room ' + r.code); open.addEventListener('click', function () { reclaim(r.code, status); }); li.append(open); }
        list.append(li);
      });
      var out = el('button', 'btn acct-out', 'Sign out'); out.type = 'button';
      out.addEventListener('click', async function () { await call('POST', '/api/auth/sign-out', {}); closeDialog(); await refresh(); });
      panel.append(list, status, out);
    });
  }
  function drawHeader(box) {
    var code = box.getAttribute('data-code') || '';
    if (!ready) return;
    var b = el('button', me ? 'acct-btn chip' : 'acct-btn btn'); b.type = 'button'; b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', 'false');
    if (!me) { b.textContent = 'Sign in'; b.addEventListener('click', function () { signInDialog(b, 'Sign in'); }); }
    else {
      var av = el('span', 'acct-av', firstName(me).charAt(0).toUpperCase()); av.setAttribute('aria-hidden', 'true');
      b.append(av, el('span', 'acct-name', firstName(me))); b.setAttribute('aria-label', 'Account menu for ' + firstName(me));
      b.addEventListener('click', function () { menu(b, code); });
    }
    box.append(b);
  }

  // ---- "Keep this room" toggle on the host page ----
  function drawKeep(box) {
    var code = box.getAttribute('data-code') || '', H = window.RoomBlendHost;
    if (!ready) return;
    var kept = !!me && rooms.some(function (r) { return r.code === code; });
    var b = el('button', 'btn small keep-chip', kept ? '✓ Room kept' : 'Keep this room'); b.type = 'button';
    b.setAttribute('aria-pressed', String(kept)); b.setAttribute('aria-label', 'Keep this room'); b.title = 'Kept rooms last ' + DAYS + ' days after their last use, and open on any device you sign in on.';
    var status = el('span', 'hint keep-hint', kept ? 'Kept for ' + DAYS + ' days after last use.' : 'Kept rooms last ' + DAYS + ' days.'); status.setAttribute('role', 'status');
    b.addEventListener('click', async function () {
      if (!me) { signInDialog(b, 'Sign in to keep this room'); return; }
      if (!H) return;
      b.disabled = true;
      var r = await call(kept ? 'DELETE' : 'POST', '/api/rooms/' + code + '/host/claim', kept ? null : {}, H.headers);
      if (!r.ok) { b.disabled = false; status.textContent = why(r, 'Could not update this room.'); return; }
      await refresh();
      var nb = box.querySelector('.keep-chip'); if (nb) nb.focus();
    });
    box.append(b, status);
  }

  // ---- the "this browser did not start room X" page ----
  function drawLocked(box) {
    var code = box.getAttribute('data-code') || '';
    if (!ready) return;
    var sec = el('section', 'acct-locked'); sec.setAttribute('aria-label', 'Take over this room');
    var status = el('p', 'hint acct-err'); status.setAttribute('role', 'status');
    sec.append(el('h2', null, 'Is this your room?'));
    if (!me) {
      sec.append(el('p', null, 'If you kept room ' + code + ' under your account, sign in to take it over on this device.'));
      var s = el('button', 'btn primary', 'Sign in to take over'); s.type = 'button'; s.addEventListener('click', function () { signInDialog(s, 'Sign in to take over'); });
      sec.append(s);
    } else {
      var mine = rooms.some(function (r) { return r.code === code; });
      if (mine) {
        sec.append(el('p', null, 'Room ' + code + ' is kept under your account.'));
        var t = el('button', 'btn primary', 'Take over room ' + code); t.type = 'button'; t.addEventListener('click', function () { reclaim(code, status); });
        sec.append(t);
      } else sec.append(el('p', null, 'This room is not kept under your account.'));
      var out = el('button', 'btn small acct-link', 'Signed in as ' + firstName(me) + '. Sign out'); out.type = 'button';
      out.addEventListener('click', async function () { await call('POST', '/api/auth/sign-out', {}); await refresh(); });
      sec.append(out);
    }
    sec.append(status); box.append(sec);
  }

  function scan() {
    [['account-mount', null], ['keep-mount', drawKeep]].forEach(function (k) {
      var m = document.getElementById(k[0]);
      if (!m || m.getAttribute('data-ready')) return;
      m.setAttribute('data-ready', '1');
      var fn = k[1] || (m.getAttribute('data-mode') === 'locked' ? drawLocked : drawHeader);
      mounts.push({ box: m, draw: fn }); if (ready) fn(m);
    });
    mounts = mounts.filter(function (m) { return m.box.isConnected; });
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan(); refresh();
  window.RoomBlendAccount = { refresh: refresh };
})();
