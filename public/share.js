// "Share your room": a collapsible help panel on the host page. Mounts into #share-mount (see public/app.js).
// Tells hosts how to get the music and the TV view to remote people on Discord, Zoom, Meet and Teams.
// Plain DOM, textContent only, no dependencies. Keep LAST_CHECKED and each guide's `url` in step with the official help pages.
(function () {
  'use strict';
  var LAST_CHECKED = '2026-11-13';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  var SOUND = 'The music plays on your computer, from the Room Blend host page, so that is the computer whose sound you share. Share the TV / cast view (open it from the host page) and make sure the sound goes with it.';
  var APPS = [
    { id: 'discord', name: 'Discord', url: 'https://support.discord.com/hc/en-us/articles/360041721052-Video-Calls',
      steps: [
        'Join a server voice channel, then click the Go Live (screen) icon in the voice panel at the bottom left.',
        'Pick the browser window that shows the TV / cast view, or your whole screen, then click Go Live.',
        'Sound: we could not confirm from Discord’s help pages how window or screen audio is shared in the current app, so check that your viewers can hear the music. If they cannot, look for a sound or audio option in the share picker or in Voice & Video settings.'] },
    { id: 'zoom', name: 'Zoom', url: 'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063608',
      steps: [
        'In the meeting, click Share Screen.',
        'Choose the browser window (or tab) that shows the TV / cast view.',
        'Turn on Share Sound in the share window, then click Share. You can also turn it on later from More on the share toolbar.',
        'Joined by phone as well as computer? Mute one of them, or the sound will echo.'] },
    { id: 'meet', name: 'Google Meet', url: 'https://support.google.com/meet/answer/9308856?hl=en',
      steps: [
        'Use Chrome on a computer. Join the meeting and click Present now.',
        'Choose A tab, and pick the tab that shows the TV / cast view.',
        'Chrome normally shares the tab’s sound too. If viewers hear nothing, check for an “Also share tab audio” switch in the picker.',
        'Click Share.'] },
    { id: 'teams', name: 'Microsoft Teams', url: 'https://support.microsoft.com/en-us/office/share-sound-from-your-computer-in-a-teams-meeting-or-live-event-dddede9f-e3d0-4330-873a-fa061a0d8e3b',
      steps: [
        'In the meeting, click Share.',
        'Switch on Include sound (Microsoft’s page calls it “Include sound”; older versions said “Include computer sound”).',
        'Choose the window or screen that shows the TV / cast view.',
        'On Windows, Teams and Room Blend must use the same speakers. On a Mac you may need the Teams audio driver. In a Teams Room, join from your own laptop with its audio off and share from there.'] }
  ];

  function inviteText(code, url) {
    return 'Come pick the music with us! Open ' + url + ' (room code ' + code + ') and choose a few genres you like, and the room plays songs we all enjoy.';
  }

  function copy(text) {
    function fallback() {
      return new Promise(function (resolve, reject) {
        var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.select();
        var okc = false; try { okc = document.execCommand('copy'); } catch (e) { okc = false; }
        document.body.removeChild(t); okc ? resolve() : reject(new Error('copy failed'));
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(fallback);
    return fallback();
  }

  function mount(box) {
    if (box.getAttribute('data-ready')) return;
    var code = box.getAttribute('data-code') || (window.RoomBlendHost && window.RoomBlendHost.code); if (!code) return;
    box.setAttribute('data-ready', '1');
    var C = window.CONFIG || {};
    var link = (C.publicUrl || location.origin) + '/' + code;
    var det = el('details', 'panel secondary share'); det.id = 'share';
    det.appendChild(el('summary', null, 'Share your room'));
    var body = el('div', 'share-body'); det.appendChild(body);

    body.appendChild(el('p', 'hint', 'Hosting for people on a call? ' + SOUND + ' Guests then scan the QR code on that view, or open the link from the call chat.'));
    var row = el('div', 'row share-actions'), status = el('span', 'hint', ''); status.setAttribute('role', 'status');
    function btn(id, label, text, done) {
      var b = el('button', 'btn small', label); b.type = 'button'; b.id = id;
      b.addEventListener('click', function () {
        copy(text).then(function () { status.textContent = done; }, function () { status.textContent = 'Could not copy. Select the link and copy it by hand.'; });
      });
      return b;
    }
    row.appendChild(btn('share-copy-invite', 'Copy invite message', inviteText(code, link), 'Invite message copied.'));
    row.appendChild(btn('share-copy-link', 'Copy link', link, 'Link copied.'));
    row.appendChild(status); body.appendChild(row);
    body.appendChild(el('p', 'share-link', link));

    APPS.forEach(function (a) {
      var d = el('details', 'share-app'); d.id = 'share-' + a.id; d.appendChild(el('summary', null, a.name));
      var ol = el('ol'); a.steps.forEach(function (s) { ol.appendChild(el('li', null, s)); }); d.appendChild(ol);
      var p = el('p', 'hint'); p.appendChild(document.createTextNode('Official help: '));
      var l = el('a', null, a.url); l.href = a.url; l.target = '_blank'; l.rel = 'noopener noreferrer'; p.appendChild(l); d.appendChild(p);
      body.appendChild(d);
    });
    var gen = el('details', 'share-app'); gen.id = 'share-other'; gen.appendChild(el('summary', null, 'Anything else (OBS, streaming)'));
    gen.appendChild(el('p', null, 'Capture the browser window or tab that shows the TV / cast view, and add that same window’s sound (in OBS, a Window Capture plus an audio capture of the browser). Then put the join link in your stream chat or description.'));
    body.appendChild(gen);
    body.appendChild(el('p', 'hint share-checked', 'Last checked: ' + LAST_CHECKED + '. Menu names change between app versions, so the official help link is the final word.'));
    box.appendChild(det);
  }

  function scan() { var m = document.getElementById('share-mount'); if (m) mount(m); }
  window.RoomBlendShare = { inviteText: inviteText, apps: APPS, lastChecked: LAST_CHECKED };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
