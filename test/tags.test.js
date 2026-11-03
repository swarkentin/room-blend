'use strict';
// Tag reader and genre mapping, against real files made by ffmpeg (skipped if ffmpeg is missing).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const Tags = require('../public/tags.js'), GM = require('../public/genremap.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };

const cases = { 'Rock': ['rock'], 'Alternative & Punk': ['alternative', 'punk'], 'Hip-Hop/Rap': ['hip hop'], '(17)': ['rock'], 'Blues; Soul': ['blues', 'soul'],
  'R&B': ['r&b'], 'Singer/Songwriter': ['singer-songwriter'], 'Drum & Bass': ['drum and bass'], 'Pop/Rock': ['pop', 'rock'], 'IDM': ['idm'], 'Lo-Fi Chill': ['lo-fi'], 'Downtempo; Ambient': ['downtempo', 'ambient'], 'Synthwave': ['synthwave'], 'Shoegaze/Dream Pop': ['shoegaze'], 'Neo-Soul': ['neo soul'], 'Hyperpop': ['hyperpop'], 'Trip-Hop': ['trip hop'], 'Unknown': [], '': [] };
for (const [tag, want] of Object.entries(cases)) assert.deepStrictEqual(GM.fromTag(tag), want, tag);
ok('genre tags map to canonical genres (' + Object.keys(cases).length + ' cases)');
// The genres added with the regrouped picker, as file taggers and music services name them.
const more = { 'Soundtrack': ['soundtrack'], 'Showtunes': ['soundtrack'], 'Musical': ['soundtrack'], 'Bollywood': ['bollywood'], 'Punjabi': ['bollywood'], 'J-Pop': ['j-pop'], 'Anime': ['j-pop'], 'City Pop': ['j-pop'], 'K-Pop': ['k-pop'],
  'Samba': ['brazilian'], 'MPB': ['brazilian'], 'Sertanejo': ['brazilian'], 'Bossa Nova': ['bossa nova'], 'Djent': ['metal'], 'Progressive Metal': ['metal'], 'Metal; Djent': ['metal'], 'Hip-Hop; R&B': ['hip hop', 'r&b'], 'Classical': ['classical'] };
for (const [tag, want] of Object.entries(more)) assert.deepStrictEqual(GM.fromTag(tag), want, tag);
const named = { 'djent': 'metal', 'orchestral soundtrack': 'soundtrack', 'movie tunes': 'soundtrack', 'video game music': 'soundtrack', 'desi hip hop': 'bollywood', 'japanese city pop': 'j-pop', 'j-rock': 'j-pop', 'korean pop': 'k-pop',
  'funk carioca': 'brazilian', 'baile funk': 'brazilian', 'bossa nova': 'bossa nova', 'trap latino': 'reggaeton', 'indie rock': 'indie', 'classic rock': 'classic rock', 'soft rock': 'classic rock', 'modern country rock': 'country' };
for (const [name, want] of Object.entries(named)) assert.strictEqual(GM.classify(name), want, name);
ok('soundtrack, Bollywood, J-pop (apart from K-pop), Brazilian and djent tags map to their genres, and earlier rules still win where they should (' + (Object.keys(more).length + Object.keys(named).length) + ' cases)');
assert.deepStrictEqual(Tags.fromFilename('03 - Artist Name - Song Title.mp3'), { artist: 'Artist Name', title: 'Song Title' });
assert.deepStrictEqual(Tags.fromFilename('Just A Title.flac'), { title: 'Just A Title' }); ok('filenames are a fallback for title and artist');

(async () => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.log('  --  ffmpeg missing: skipping real-file checks'); console.log(n + ' checks passed'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-tags-'));
  const fmts = [['a.mp3', 'libmp3lame', ['-id3v2_version', '3']], ['b.mp3', 'libmp3lame', ['-id3v2_version', '4']], ['c.m4a', 'aac', []], ['d.flac', 'flac', []], ['e.ogg', 'libvorbis', []], ['f.opus', 'libopus', []]];
  for (const [f, codec, extra] of fmts) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=0.5', '-c:a', codec, ...extra, '-metadata', 'title=Café Song', '-metadata', 'artist=Zoë', '-metadata', 'genre=Blues; Soul', path.join(dir, f)]);
    const t = await Tags.read(Tags.bufferReader(fs.readFileSync(path.join(dir, f))), f);
    assert.deepStrictEqual([t.title, t.artist, t.genre], ['Café Song', 'Zoë', 'Blues; Soul'], f);
  }
  ok('title, artist and genre read from mp3 (ID3v2.3 and 2.4), m4a, flac, ogg and opus');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=0.5', path.join(dir, 'Some Band - Plain Song.wav')]);
  const w = await Tags.read(Tags.bufferReader(fs.readFileSync(path.join(dir, 'Some Band - Plain Song.wav'))), 'Some Band - Plain Song.wav');
  assert.deepStrictEqual([w.title, w.artist, w.genre], ['Plain Song', 'Some Band', '']); ok('an untagged wav falls back to its file name');
  const junk = await Tags.read(Tags.bufferReader(Buffer.from('not audio at all, just text')), 'x.mp3'); assert.strictEqual(junk.title, 'x'); ok('garbage input does not throw');
  const trunc = fs.readFileSync(path.join(dir, 'a.mp3')).subarray(0, 40);
  await Tags.read(Tags.bufferReader(trunc), 'a.mp3'); ok('a truncated file does not throw');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(n + ' checks passed');
})().catch((e) => { console.error('FAILED:', e.stack); process.exit(1); });
