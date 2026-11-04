// Fuzzy matching of a wanted song ("title by artist") against search results from a music service.
// Used by the Spotify and YouTube sources. Works in the browser (window.Match) and in Node (tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Match = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var STOP = { the: 1, a: 1, an: 1, and: 1, of: 1, feat: 1, ft: 1, featuring: 1, with: 1, official: 1, video: 1, audio: 1, lyrics: 1, lyric: 1, music: 1, hd: 1, hq: 1 };
  // Versions of a song we do not want unless the wanted title asks for them.
  var BAD = /\b(karaoke|reaction|tutorial|lesson|8d|slowed|nightcore|sped up|instrumental|remix|mashup|tribute|made famous|in the style of|originally performed|lyrics?|fan.?made|unofficial|bootleg)\b/i;
  var COVER = /(?:[([{]\s*cover\b|\bcover\s+(?:version|by|song)\b|\bcovered by\b|\bfan cover\b|\bcover\s*$)/i;
  var LIVE_VERSION = /(?:\blive\s+(?:at|in|from|on|version|recording|performance|session)\b|[([{]\s*live\b|\s[-\u2013\u2014]\s*live(?:\b|$)|\blive\s*$)/i;
  function badVersion(title) { return BAD.test(title || '') || COVER.test(title || '') || LIVE_VERSION.test(title || ''); }

  // Karaoke and tribute acts are the only artist names worth rejecting (a band may really be called "Live").
  var ARTIST_BAD = /\b(karaoke|tribute|cover band|made famous)\b/i;

  function plain(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[‘’']/g, '');
  }
  function words(s) { return plain(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean); }
  function core(s) { return words(s).filter(function (w) { return !STOP[w]; }); }

  // "Alive (Remastered 2011)", "Alive - Live at ...", "Alive [Official Video]", "Alive (feat. X)" -> "Alive".
  // Parentheses that are part of the title, like "(I Can't Get No) Satisfaction", stay.
  var NOISE = /^(live|remaster|remastered|.*\bversion\b|mono|stereo|single|edit|radio|feat|ft|with|from|original|deluxe|bonus|explicit|clean|official|audio|video|lyrics?|\d{4})\b/i;
  function cleanTitle(t) {
    var s = String(t == null ? '' : t);
    s = s.replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, function (m, inner) { return NOISE.test(inner.trim()) ? '' : m; });
    s = s.replace(/\s+-\s+(live\b|remaster|remastered|\d{4}\b|mono|stereo|single|radio|from\b|original|bonus|feat\b).*$/i, '');
    s = s.replace(/\s+[-\u2013|]\s*(official\b.*|lyrics?\b.*|audio\b.*|video\b.*|hd\b.*|hq\b.*)$/i, '');
    s = s.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '');
    return s.trim();
  }
  // "Charli XCX (Hyper)" -> "Charli XCX". Only the first of several credited artists is used for searching.
  function cleanArtist(a) {
    var s = String(a == null ? '' : a).replace(/\s*\([^)]*\)\s*$/, '');
    s = s.split(/\s+(?:feat\.?|ft\.?|featuring|with|x)\s+/i)[0];
    return s.trim();
  }

  // Share of the wanted words that appear in the candidate (0..1).
  function coverage(wanted, have) {
    if (!wanted.length) return 0;
    var set = {}; have.forEach(function (w) { set[w] = 1; });
    var n = 0; wanted.forEach(function (w) { if (set[w]) n++; });
    return n / wanted.length;
  }
  function artistWords(a) {
    var w = core(cleanArtist(a));
    return w.length ? w : core(a);
  }

  // Scores a result that is a song entry (Spotify): its own title and its list of artist names.
  // Returns { title, artist, bad, score } with title/artist in 0..1.
  function scoreTrack(want, cand) {
    var wt = core(cleanTitle(want.title)), ct = core(cleanTitle(cand.title));
    var inter = wt.filter(function (w) { return ct.indexOf(w) >= 0; }).length;
    var extra = ct.filter(function (w) { return wt.indexOf(w) < 0; }).length;
    var title = wt.length ? Math.max(0, inter / wt.length - 0.5 * (extra / Math.max(1, ct.length))) : 0;
    var bag = []; (cand.artists || []).forEach(function (a) { bag = bag.concat(core(a)); });
    var artist = coverage(artistWords(want.artist), bag);
    var bad = (badVersion(cand.title) || ARTIST_BAD.test((cand.artists || []).join(' '))) && !badVersion(want.title);
    return { title: title, artist: artist, bad: bad, score: title * 2 + artist - (bad ? 1.5 : 0) + (cand.popularity ? cand.popularity / 1000 : 0) };
  }
  // Scores a video (YouTube): the title and channel name hold both song and artist, in any order.
  function scoreVideo(want, video) {
    var hay = core(video.title + ' ' + (video.channel || ''));
    var title = coverage(core(cleanTitle(want.title)), hay), artist = coverage(artistWords(want.artist), hay);
    var bad = badVersion(video.title) && !badVersion(want.title);
    var official = /vevo|official|topic/i.test(video.channel || '') ? 0.2 : 0;
    return { title: title, artist: artist, bad: bad, score: title * 2 + artist - (bad ? 1.5 : 0) + official };
  }
  // The result is acceptable when most of the title and some of the artist match.
  function acceptable(s) { return s.title >= 0.6 && s.artist >= 0.5 && !s.bad; }

  // Best first. Each entry: { item, s }.
  function rank(want, items, toCand, scorer) {
    scorer = scorer || scoreTrack;
    return items.map(function (it, i) { var s = scorer(want, toCand(it)); s.score -= i * 0.001; return { item: it, s: s }; })
      .sort(function (a, b) { return b.s.score - a.s.score; });
  }

  // True for versions of a song we would not queue unasked: live, karaoke, remix, cover, compilations...
  var JUNK = /full album|playlist|compilation|\bmix\b|\bhours?\b|non-?stop|medley|top \d+|best of|reaction/i;
  function isBad(title) { return badVersion(title) || JUNK.test(title || ''); }

  return { isBad: isBad, words: words, core: core, cleanTitle: cleanTitle, cleanArtist: cleanArtist, scoreTrack: scoreTrack, scoreVideo: scoreVideo, acceptable: acceptable, rank: rank };
});
