// Maps Spotify's many micro-genres ("modern rock", "indie folk", "trap latino") onto the
// 56 canonical genres the engine uses. Works in the browser (window.GenreMap) and Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenreMap = factory();
})(globalThis, function () {
  // Order matters: the first matching rule wins, so specific styles come before general ones.
  /** @type {Array<[string, RegExp]>} */
  var RULES = [
    ['christmas', /christmas|xmas|^holiday|yule/],
    ['halloween', /halloween|spooky/],
    ['lo-fi', /lo-?fi|chillhop/],
    ['trip hop', /trip hop|trip-hop|bristol sound|portishead/],
    ['reggaeton', /reggaeton|urbano|latin trap|trap latino|perreo/],
    ['trap', /\btrap\b|drill|cloud rap|phonk/],
    ['hip hop', /hip hop|hip-hop|\brap\b|grime|boom bap|crunk/],
    ['dancehall', /dancehall|ragga|soca/],
    ['ska', /\bska\b|rocksteady|2 tone|two tone/],
    ['amapiano', /amapiano|gqom|kwaito/],
    ['afrobeats', /afrobeat|afropop|afro pop|afro swing|amapiano|highlife|naija/],
    ['reggae', /reggae|\bdub\b|lovers rock/],
    ['k-pop', /k-pop|kpop|korean|j-pop|city pop/],
    ['hyperpop', /hyperpop|pc music|digicore|glitchcore/],
    ['dance pop', /dance pop|europop|eurodance|hi-nrg/],
    ['synthwave', /synthwave|retrowave|outrun|darksynth/],
    ['chillwave', /chillwave|glo-fi|vaporwave|witch house/],
    ['synth pop', /synth ?pop|electropop|futurepop/],
    ['dubstep', /dubstep|brostep|riddim|future garage|uk bass/],
    ['edm', /\bedm\b|big room|progressive house|electro house|future bass|hardstyle|trance|moombahton/],
    ['drum and bass', /drum and bass|drum & bass|\bdnb\b|jungle|breakbeat/],
    ['idm', /\bidm\b|intelligent dance|glitch|braindance|electronica|hauntology|leftfield/],
    ['techno', /techno|acid house|detroit|industrial/],
    ['metal', /metal|thrash|doom|deathcore/],
    ['pop punk', /pop punk|pop-punk|easycore/],
    ['emo', /\bemo\b|screamo/],
    ['new wave', /new wave|post-punk|no wave|goth|darkwave|coldwave/],
    ['punk', /punk|hardcore|oi!/],
    ['grunge', /grunge/],
    ['hard rock', /hard rock|glam rock|stoner|heavy rock/],
    ['classic rock', /classic rock|southern rock|album rock|soft rock|yacht rock|psychedelic|folk rock|arena rock|heartland/],
    ['blues', /blues/],
    ['gospel', /gospel|worship|christian|spiritual/],
    ['neo soul', /neo soul|neo-soul|nu soul/],
    ['r&b', /r&b|rnb|r and b|urban contemporary|quiet storm|new jack/],
    ['soul', /soul|motown/],
    ['funk', /funk|go-go/],
    ['disco', /disco|boogie|nu-disco|italo/],
    ['swing', /swing|big band|jive|lindy/],
    ['downtempo', /downtempo|balearic|nu jazz/],
    ['chillout', /chillout|chill out|chill-out|lounge|\bchill\b|easy listening/],
    ['bossa nova', /bossa|samba|\bmpb\b/],
    ['jazz', /jazz|bebop|\bbop\b|standards/],
    ['americana', /americana|alt-country|alt country|outlaw|roots rock|red dirt|texas country/],
    ['country', /country|bluegrass|nashville|honky|western/],
    ['singer-songwriter', /singer-songwriter|singer songwriter|troubadour|acoustic|coffeehouse/],
    ['folk', /folk|celtic|traditional|sea shanty|irish|scottish/],
    ['latin', /latin|salsa|bachata|cumbia|merengue|latino|mariachi|tango|flamenco|ranchera|banda|vallenato/],
    ['ambient', /ambient|new age|drone|meditat/],
    ['shoegaze', /shoegaze|dream pop|slowcore|nu gaze|blackgaze/],
    ['post-rock', /post-rock|post rock|math rock|instrumental rock/],
    ['indie', /indie|chamber pop|noise pop|twee|bedroom/],
    ['alternative', /alternative|britpop|garage rock|art rock|art pop|new rave|\balt\b/],
    ['house', /house|garage|club|\bdance\b/],
    ['electronic', /electro|synth|wave/],
    ['classical', /classical|baroque|orchestra|opera|symphon|chamber music|piano(?! rock| pop)|romantic era|choral|soundtrack|film score|string quartet|early music|minimalis/],
    ['rock', /\brock\b|rock and roll|rock & roll|rockabilly|\bmod\b|surf/],
    ['pop', /\bpop\b|teen|boy band|girl group|bubblegum|top 40|adult contemporary/],
  ];

  function classify(genre) {
    var g = String(genre || '').toLowerCase();
    for (var i = 0; i < RULES.length; i++) if (RULES[i][1].test(g)) return RULES[i][0];
    return null;
  }

  // Every canonical genre a compound name stands for, strongest first: "blues rock" gives [blues, rock],
  // "classic rock" gives [classic rock]. Each rule that matches uses up the words it matched.
  function classifyAll(genre, max) {
    max = max || 3;
    var g = String(genre || '').toLowerCase(), out = [];
    while (out.length < max) {
      var hit = null;
      for (var i = 0; i < RULES.length && !hit; i++) { var m = RULES[i][1].exec(g); if (m && m[0]) hit = [RULES[i][0], m[0]]; }
      if (!hit) break;
      if (out.indexOf(hit[0]) < 0) out.push(hit[0]);
      g = g.replace(hit[1], ' ');
    }
    return out;
  }

  // artistGenreLists: array of arrays (one list of Spotify genres per top artist, most listened first).
  // Earlier artists count more. Returns up to `max` canonical genres, strongest first.
  function fromArtists(artistGenreLists, max) {
    max = max || 4;
    var score = {}, total = artistGenreLists.length;
    artistGenreLists.forEach(function (list, rank) {
      var w = 1 + (total - rank) / Math.max(total, 1);
      var seen = {};
      (list || []).forEach(function (sg) {
        var c = classify(sg);
        if (c && !seen[c]) { seen[c] = 1; score[c] = (score[c] || 0) + w; }
      });
    });
    return Object.keys(score).sort(function (a, b) { return score[b] - score[a]; }).slice(0, max);
  }

  // Free-form tag text from a music file or server: "Rock/Pop", "Alternative & Punk", "Hip-Hop; R&B".
  // Returns up to `max` canonical genres in the order they appear.
  var ID3V1 = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','AlternRock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock'];
  function fromTag(tag, max) {
    max = max || 3;
    var t = String(tag == null ? '' : tag).trim();
    var m = /^\((\d{1,3})\)(.*)$/.exec(t) || /^(\d{1,3})$/.exec(t);
    if (m && ID3V1[+m[1]]) t = ID3V1[+m[1]] + (m[2] ? ';' + m[2] : '');
    var out = [];
    t.split(/[\/;,\u0000|]+|\s{2,}|\s&\s(?=[A-Za-z])|\s\+\s/).forEach(function (part) {
      var c = classify(part) || classify(part.replace(/[-_]/g, ' '));
      if (c && out.indexOf(c) < 0 && out.length < max) out.push(c);
    });
    if (!out.length) { var whole = classify(t) || classify(t.replace(/\s&\s/g, ' and ')) || classify(t.replace(/\//g, '-')); if (whole) out.push(whole); }
    return out;
  }

  return { classify: classify, classifyAll: classifyAll, fromArtists: fromArtists, fromTag: fromTag, ID3V1: ID3V1 };
});
