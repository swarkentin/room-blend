// What to ask a music service for, per genre. The service supplies the songs (so they are always playable and
// need no matching); this file only says which genre names to search and which tags the results get.
//
// A search for "blues rock" returns songs that are blues and rock at once, which is what lets a blues fan and a
// rock fan blend. So besides each genre's own name we also search a short list of real compound genre names
// (BRIDGES) that contain it, and tag the results with every genre in the name.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./genremap.js'));
  else root.Pools = factory(root.GenreMap);
})(typeof self !== 'undefined' ? self : this, function (GenreMap) {
  // The name the services use for each of our genres.
  var MAIN = {
    'rock': 'rock', 'classic rock': 'classic rock', 'hard rock': 'hard rock', 'alternative': 'alternative rock', 'indie': 'indie rock', 'grunge': 'grunge',
    'punk': 'punk', 'pop punk': 'pop punk', 'new wave': 'new wave', 'metal': 'metal', 'emo': 'emo', 'shoegaze': 'shoegaze', 'post-rock': 'post-rock',
    'blues': 'blues', 'country': 'country', 'folk': 'folk', 'americana': 'americana', 'singer-songwriter': 'singer-songwriter',
    'jazz': 'jazz', 'swing': 'swing', 'bossa nova': 'bossa nova', 'soul': 'soul', 'r&b': 'r&b', 'funk': 'funk', 'disco': 'disco', 'gospel': 'gospel', 'neo soul': 'neo soul',
    'pop': 'pop', 'dance pop': 'dance pop', 'synth pop': 'synthpop', 'k-pop': 'k-pop', 'j-pop': 'j-pop', 'hyperpop': 'hyperpop',
    'electronic': 'electronic', 'house': 'house', 'techno': 'techno', 'edm': 'edm', 'dubstep': 'dubstep', 'drum and bass': 'drum and bass', 'idm': 'idm', 'ambient': 'ambient',
    'downtempo': 'downtempo', 'chillout': 'chillout', 'lo-fi': 'lo-fi', 'trip hop': 'trip hop', 'synthwave': 'synthwave', 'chillwave': 'chillwave',
    'hip hop': 'hip hop', 'trap': 'trap', 'reggae': 'reggae', 'ska': 'ska', 'dancehall': 'dancehall', 'latin': 'latin', 'reggaeton': 'reggaeton', 'afrobeats': 'afrobeats', 'amapiano': 'amapiano',
    'bollywood': 'bollywood', 'brazilian': 'mpb', // Spotify's own genre for Brazilian popular music is "mpb"
    'classical': 'classical', 'soundtrack': 'soundtrack', 'christmas': 'christmas', 'halloween': 'halloween',
  };
  // Real compound genre names, most useful first. Each is tagged with every genre it names.
  var BRIDGES = [
    'blues rock', 'country rock', 'pop rock', 'funk rock', 'punk rock', 'indie pop', 'indie folk',
    'jazz blues', 'soul blues', 'country blues', 'soul jazz', 'jazz funk', 'latin jazz', 'jazz rap',
    'country pop', 'folk pop', 'country folk', 'funk soul', 'pop soul', 'hip hop soul', 'pop rap', 'r&b hip hop',
    'house pop', 'electro pop', 'electro swing', 'lo-fi hip hop', 'lo-fi jazz', 'ambient house',
    'latin pop', 'latin rock', 'latin hip hop', 'reggae rock', 'ska punk', 'dancehall pop',
    'funk metal', 'alternative metal', 'gothic rock', 'synth rock', 'emo pop', 'pop punk emo', 'swing jazz', 'gospel blues', 'gospel soul',
    'orchestral soundtrack', 'anime soundtrack', 'bollywood pop', 'desi hip hop', 'japanese rock', 'brazilian jazz', 'brazilian funk',
  ];

  var tagCache = {};
  // The canonical genres a service genre name stands for, strongest first (up to 3).
  function tagsFor(name) {
    if (!tagCache[name]) tagCache[name] = GenreMap.classifyAll(name, 3);
    return tagCache[name];
  }

  // The searches to run for one genre: its own name first, then up to n - 1 compound names that include it.
  // Each is {q, tags}; tags always lead with the genre asked for. `partners` are the genres other guests in the room
  // picked: compound names that include one of them come first, because those are the songs two guests can share.
  function queries(genre, n, partners) {
    n = n || 3;
    var main = MAIN[genre];
    if (!main) return [];
    partners = partners || [];
    var out = [{ q: main, tags: lead(genre, tagsFor(main)) }], withGenre = [];
    BRIDGES.forEach(function (b) { var t = tagsFor(b); if (t.length > 1 && t.indexOf(genre) >= 0) withGenre.push({ q: b, tags: lead(genre, t) }); });
    var shared = withGenre.filter(function (c) { return c.tags.some(function (g) { return partners.indexOf(g) >= 0 && g !== genre; }); });
    shared.concat(withGenre.filter(function (c) { return shared.indexOf(c) < 0; })).forEach(function (c) { if (out.length < n) out.push(c); });
    return out;
  }
  function lead(genre, tags) {
    var rest = tags.filter(function (t) { return t !== genre; });
    return [genre].concat(rest).slice(0, 3);
  }

  return { MAIN: MAIN, BRIDGES: BRIDGES, tagsFor: tagsFor, queries: queries };
});
