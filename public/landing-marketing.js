(function () {
  'use strict';

  var style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/landing-marketing.css';
  document.head.appendChild(style);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function feature(icon, title, copy) {
    var item = el('article', 'landing-feature');
    item.append(el('span', 'landing-feature-icon', icon), el('h3', null, title), el('p', null, copy));
    return item;
  }

  function step(number, title, copy) {
    var item = el('li', 'landing-step');
    item.append(el('span', 'landing-step-number', number), el('div', 'landing-step-copy', ''));
    item.lastChild.append(el('strong', null, title), el('span', null, copy));
    return item;
  }

  function makeArtwork() {
    var art = el('div', 'landing-art');
    art.setAttribute('aria-hidden', 'true');
    var glow = el('div', 'landing-art-glow');
    var orbit = el('div', 'landing-art-orbit');
    var top = el('div', 'landing-art-topline');
    top.append(el('span', null, 'ROOM BLEND / LIVE MIX'), el('span', 'landing-live', '● LIVE'));
    var people = el('div', 'landing-art-people');
    [
      ['M', 'Maya', 'rock · blues', 'person-one'],
      ['D', 'Dev', 'blues · jazz', 'person-two'],
      ['S', 'Sam', 'hip hop · R&B', 'person-three']
    ].forEach(function (person) {
      var p = el('div', 'landing-person ' + person[3]);
      p.append(el('span', 'landing-person-avatar', person[0]), el('span', 'landing-person-copy', ''));
      p.lastChild.append(el('strong', null, person[1]), el('small', null, person[2]));
      people.appendChild(p);
    });
    var connector = el('div', 'landing-flow-line');
    var mix = el('div', 'landing-mix-card');
    mix.append(el('span', 'landing-mix-kicker', 'THE ROOM MIX'), el('strong', 'landing-mix-title', 'A little of everyone.'), el('span', 'landing-mix-sub', 'Shared taste, discovered together'));
    var wave = el('div', 'landing-wave');
    for (var i = 0; i < 24; i++) wave.appendChild(el('i'));
    mix.appendChild(wave);
    var queue = el('div', 'landing-art-queue');
    queue.append(el('span', null, 'UP NEXT'), el('strong', null, 'The songs that bring you together'), el('small', null, 'And a fair turn when they don’t'));
    art.append(glow, orbit, top, people, connector, mix, queue);
    return art;
  }

  function decorate() {
    var hero = document.querySelector('#app .hero');
    if (!hero || hero.classList.contains('landing-home') || !hero.querySelector('#join-form')) return;
    var account = hero.querySelector('.acct-bar');
    var heading = hero.querySelector('h1');
    var lead = hero.querySelector('.lead');
    var actions = hero.querySelector('.cta-row');
    var note = hero.querySelector('.cta-note');
    var how = hero.querySelector('.how-line');
    var nearby = hero.querySelector('#nearby');
    var mine = hero.querySelector('#mine');
    var join = hero.querySelector('#join-form');
    if (!account || !heading || !lead || !actions || !how || !join) return;

    hero.classList.add('landing-home');
    var main = el('section', 'landing-hero');
    main.setAttribute('aria-label', 'Room Blend brings everyone into the music');
    var copy = el('div', 'landing-copy');
    copy.append(el('p', 'landing-eyebrow', 'BETTER NIGHTS SOUND LIKE EVERYONE'));
    copy.append(heading, lead, actions);
    if (note) copy.appendChild(note);
    copy.append(el('a', 'landing-explore', 'Explore what makes it different ↓'));
    main.append(copy, makeArtwork());

    var howSection = el('section', 'landing-how');
    howSection.id = 'how-it-works';
    howSection.setAttribute('aria-labelledby', 'landing-how-title');
    howSection.append(el('p', 'landing-eyebrow', 'THREE STEPS. THAT’S THE WHOLE SETUP.'));
    howSection.append(el('h2', null, 'From room code to room full of music.'));
    howSection.lastChild.id = 'landing-how-title';
    how.replaceChildren(
      step('01', 'Start a room', 'Choose the music source already connected to your speakers.'),
      step('02', 'Everyone joins', 'Friends scan the QR code. No app or guest account needed.'),
      step('03', 'The room shapes the mix', 'Shared tastes play first. When tastes differ, everyone gets a fair turn.')
    );
    howSection.appendChild(how);

    var features = el('section', 'landing-features');
    features.id = 'landing-features';
    features.setAttribute('aria-labelledby', 'landing-features-title');
    var featureHead = el('div', 'landing-section-head');
    featureHead.append(el('p', 'landing-eyebrow', 'NOT ANOTHER GROUP PLAYLIST'), el('h2', null, 'A jukebox that knows it’s a group night.'), el('p', null, 'Room Blend is built around the people listening — not whoever grabbed the aux first.'));
    featureHead.querySelector('h2').id = 'landing-features-title';
    features.appendChild(featureHead);
    var grid = el('div', 'landing-feature-grid');
    [
      ['↔', 'The blend is the point', 'Find the genres people share. When there’s no overlap, rotate fairly so one person never owns the night.'],
      ['♫', 'Everyone gets a say', 'Guests shape the mix with genres and artists, request songs, and vote to skip what isn’t working.'],
      ['◉', 'Keep your music setup', 'The host plays from their own Spotify, YouTube, music files or Navidrome / Subsonic library.'],
      ['⌁', 'Join without the friction', 'One QR scan gets guests in. No installs, no guest accounts, and no handing around a phone.'],
      ['✦', 'Make it a shared experience', 'Put the live room on a TV: listener avatars, request moments, playful duels and a queue everyone can see.'],
      ['▤', 'See how the night went', 'A room recap brings together the songs, genres, reactions and peak crowd — ready to share after the night.']
    ].forEach(function (f) { grid.appendChild(feature(f[0], f[1], f[2])); });
    features.appendChild(grid);

    var closing = el('section', 'landing-closing');
    closing.append(el('div', null, ''));
    closing.firstChild.append(el('p', 'landing-eyebrow', 'THE AUX IS FOR EVERYONE'), el('h2', null, 'Make the next room sound like your people.'), el('p', null, 'Start free. Invite the group. Let the room decide what’s next.'));
    var start = el('a', 'btn primary big', 'Start a room');
    start.href = '#start-room';
    start.addEventListener('click', function (event) {
      event.preventDefault();
      var button = document.getElementById('start-room');
      if (button) button.click();
    });
    closing.appendChild(start);

    hero.replaceChildren(account, main);
    if (nearby) hero.appendChild(nearby);
    if (mine) hero.appendChild(mine);
    hero.append(join, howSection, features, closing);
  }

  function scan() { decorate(); }
  var observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
