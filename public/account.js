// Optional host accounts: sign in, keep a room, "My rooms", take a room over on another device.
// Guests never see any of this. It appears only when the server has accounts enabled (CONFIG.auth).
// Mounts into #account-mount (landing page, host page, and the "this browser did not start the room" page).
// Talks to /api/auth/* (proxied to the auth provider), /api/me, /api/me/rooms and /api/rooms/:code/host/claim.
(function () {
  'use strict';
  var C = window.CONFIG || {};
  if (!C.auth) return;

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

  // Coming back from "Continue with Google": the provider returns with a one-time verifier that is exchanged for a session
  // here, through this server, so the session cookie belongs to this site. It runs on every page load, whatever the page.
  var done = (async function () {
    var p = new URLSearchParams(location.search), v = p.get('neon_auth_session_verifier');
    if (!v) return;
    p.delete('neon_auth_session_verifier');
    try { history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : '') + location.hash); } catch (e) { /* ignore */ }
    await call('GET', '/api/auth/get-session?neon_auth_session_verifier=' + encodeURIComponent(v));
  })();

  var me = null;
  async function whoAmI() { var r = await call('GET', '/api/me'); me = r.ok && r.data ? r.data.user : null; return me; }
  async function myRooms() { var r = await call('GET', '/api/me/rooms'); return r.ok && r.data ? r.data.rooms : []; }
  var ago = function (t) { var m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 2 ? 'just now' : m < 120 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };

  function signInForm(box, note, again) {
    var status = el('p', 'hint'); status.setAttribute('role', 'status');
    var google = el('button', 'btn', 'Continue with Google'); google.type = 'button';
    google.addEventListener('click', async function () {
      status.textContent = 'Opening Google…';
      var r = await call('POST', '/api/auth/sign-in/social', { provider: 'google', callbackURL: location.origin + location.pathname + location.search });
      if (r.ok && r.data && r.data.url) { location.href = r.data.url; return; }
      status.textContent = why(r, 'Google sign-in is not available right now.');
    });
    var email = el('input'); email.type = 'email'; email.placeholder = 'Email'; email.autocomplete = 'email'; email.setAttribute('aria-label', 'Email');
    var pass = el('input'); pass.type = 'password'; pass.placeholder = 'Password'; pass.autocomplete = 'current-password'; pass.setAttribute('aria-label', 'Password');
    var go = el('button', 'btn primary', 'Sign in'); go.type = 'submit';
    var swap = el('button', 'btn', 'New here? Create an account'); swap.type = 'button';
    var creating = false;
    swap.addEventListener('click', function () { creating = !creating; go.textContent = creating ? 'Create account' : 'Sign in'; swap.textContent = creating ? 'Have an account? Sign in' : 'New here? Create an account'; pass.autocomplete = creating ? 'new-password' : 'current-password'; });
    var form = el('form', 'account-form'); form.append(email, pass, el('div', 'row'));
    form.lastChild.append(go, swap);
    form.addEventListener('submit', async function (e) {
      e.preventDefault(); status.textContent = creating ? 'Creating your account…' : 'Signing in…';
      var body = { email: email.value.trim(), password: pass.value };
      if (creating) body.name = body.email.split('@')[0];
      var r = await call('POST', '/api/auth/' + (creating ? 'sign-up/email' : 'sign-in/email'), body);
      if (!r.ok) { status.textContent = why(r, creating ? 'Could not create the account.' : 'Wrong email or password.'); return; }
      await whoAmI();
      if (me) return again();
      status.textContent = 'Almost there: check your email for a link to confirm your address, then sign in.';
    });
    box.append(note, google, el('p', 'hint account-or', 'or use your email'), form, status);
  }

  async function render(box) {
    box.replaceChildren(); await done; await whoAmI();
    var mode = box.getAttribute('data-mode') || 'landing', code = box.getAttribute('data-code') || '';
    var card = el('section', 'card account'); card.id = 'account'; box.appendChild(card);
    var again = function () { render(box); };

    if (!me) {
      card.appendChild(el('h2', null, 'Host account (optional)'));
      var note = el('p', 'hint', mode === 'host'
        ? 'Sign in to keep this room for 30 days and get it back from any device. Guests never need an account.'
        : mode === 'locked'
          ? 'Is this your room? Sign in to take it over on this device.'
          : 'Hosts can sign in to keep rooms and get them back on any device. Guests never need an account.');
      signInForm(card, note, again);
      return;
    }
    var head = el('div', 'row');
    head.append(el('span', 'meta', 'Signed in as ' + (me.name || me.email)));
    var out = el('button', 'btn', 'Sign out'); out.type = 'button';
    out.addEventListener('click', async function () { await call('POST', '/api/auth/sign-out', {}); me = null; again(); });
    head.appendChild(out);
    card.append(el('h2', null, 'Host account'), head);
    var rooms = await myRooms(), status = el('p', 'hint'); status.setAttribute('role', 'status');

    if (mode === 'host') {
      var H = window.RoomBlendHost, kept = rooms.some(function (r) { return r.code === code; });
      var b = el('button', kept ? 'btn' : 'btn primary', kept ? 'Stop keeping this room' : 'Keep this room'); b.type = 'button';
      card.appendChild(el('p', 'hint', kept ? 'This room is kept: it survives for 30 days after its last use, and appears under My rooms on any device you sign in on.' : 'Keep this room so it is not deleted after a day, and so you can get it back from another device.'));
      b.addEventListener('click', async function () {
        if (!H) return;
        var r = await call(kept ? 'DELETE' : 'POST', '/api/rooms/' + code + '/host/claim', kept ? null : {}, H.headers);
        if (!r.ok) { status.textContent = why(r, 'Could not update this room.'); return; }
        again();
      });
      card.append(b, status);
    }

    if (mode === 'locked') {
      var mineHere = rooms.find(function (r) { return r.code === code; });
      if (mineHere) {
        var take = el('button', 'btn primary', 'Take over room ' + code); take.type = 'button';
        take.addEventListener('click', function () { reclaim(code, status); });
        card.append(el('p', 'hint', 'This room is kept under your account.'), take, status);
      } else card.append(el('p', 'hint', 'This room is not kept under your account.'));
    }

    if (mode !== 'locked' && rooms.length) {
      card.appendChild(el('h3', null, 'My rooms'));
      var list = el('ul', 'account-rooms');
      rooms.forEach(function (r) {
        var li = el('li'), open = el('button', 'btn', r.code === code ? 'This room' : 'Open'); open.type = 'button';
        if (r.code === code) open.disabled = true;
        open.addEventListener('click', function () { reclaim(r.code, status); });
        li.append(el('span', null, (r.name ? r.name + ' · ' : '') + r.code + ' · used ' + ago(r.touchedAt) + ' '), open);
        list.appendChild(li);
      });
      card.append(list, status);
    } else if (mode === 'landing') card.append(el('p', 'hint', 'No kept rooms yet. Start a room, then choose "Keep this room" on its page.'), status);
  }

  async function reclaim(code, status) {
    var r = await call('POST', '/api/me/rooms/' + code + '/reclaim', {});
    if (!r.ok || !r.data || !r.data.hostKey) { status.textContent = why(r, 'Could not open that room.'); return; }
    lsSet('rb-host-' + code, r.data.hostKey);
    location.href = '/host/' + code;
  }

  function scan() { var m = document.getElementById('account-mount'); if (m && !m.getAttribute('data-ready')) { m.setAttribute('data-ready', '1'); render(m); } }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  window.RoomBlendAccount = { render: render };
})();
