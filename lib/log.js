'use strict';
// Structured logging and counters for operating the server. No dependencies.
//
// One JSON line per event: {"t":"2026-11-01T20:00:00.000Z","level":"info","event":"room.created","room":"a1b2c3","rooms":4}
// info goes to stdout, warn and error to stderr. Set LOG_LEVEL to debug, info (default), warn, error or silent.
//
// Privacy: logs never hold guest names, picked genres, keys, room codes or IP addresses. A room is identified by a short
// hash of its code, and a visitor by a short hash of their address that changes every time the server starts, so you can
// follow one room or one noisy visitor through the logs without being able to join the room or find the person.
const crypto = require('node:crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let threshold = LEVELS.silent; // libraries and tests stay quiet; server.js turns logging on when it starts
const salt = crypto.randomBytes(8).toString('hex');
const startedAt = Date.now();

const counters = Object.create(null);
const tallies = Object.create(null); // name -> { key -> count }
const timers = Object.create(null); // name -> { n, sum, max }

function configure(level) {
  const l = String(level || process.env.LOG_LEVEL || 'info').toLowerCase();
  threshold = LEVELS[l] === undefined ? LEVELS.info : LEVELS[l];
  return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold);
}
const short = (s) => crypto.createHash('sha256').update(salt + String(s)).digest('hex').slice(0, 8);
const roomTag = (code) => short('room:' + code);
const visitorTag = (ip) => short('ip:' + ip);

function count(name, n = 1) { counters[name] = (counters[name] || 0) + n; }
function tally(name, key) { const t = tallies[name] || (tallies[name] = Object.create(null)); t[key] = (t[key] || 0) + 1; }
function observe(name, v) { const t = timers[name] || (timers[name] = { n: 0, sum: 0, max: 0 }); t.n++; t.sum += v; if (v > t.max) t.max = v; }

// Only plain numbers, booleans and short strings are written, so a careless caller cannot dump an object.
function clean(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) {
    const v = fields[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 120);
  }
  return out;
}
function log(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...clean(fields) }) + '\n';
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
}
const debug = (e, f) => log('debug', e, f), info = (e, f) => log('info', e, f), warn = (e, f) => log('warn', e, f), error = (e, f) => log('error', e, f);

function top(obj, n) { return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).reduce((o, [k, v]) => (o[k] = v, o), {}); }
function snapshot() {
  const t = {};
  for (const k of Object.keys(timers)) t[k] = { count: timers[k].n, avgMs: Math.round((timers[k].sum / timers[k].n) * 100) / 100, maxMs: Math.round(timers[k].max * 100) / 100 };
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    counters: { ...counters },
    timers: t,
    topGenres: top(tallies.genre, 12),
    topSources: top(tallies.source, 8),
  };
}

module.exports = { configure, log, debug, info, warn, error, count, tally, observe, snapshot, roomTag, visitorTag, LEVELS };
