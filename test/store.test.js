'use strict';
// Storage backends. The memory store always runs. Postgres runs when TEST_DATABASE_URL points at a THROWAWAY database
// (use Neon's direct, non-pooler connection string; the test makes and drops its own schema, and touches nothing else).
//   TEST_DATABASE_URL='postgresql://...' node test/store.test.js
const assert = require('assert');
const contract = require('./store.contract');
const { createMemoryStore, createStore } = require('../lib/store');
const { createPgStore, MIGRATIONS } = require('../lib/pgstore');

let passed = 0;
const ok = (n) => { passed++; console.log('  ok  ' + n); };

(async () => {
  assert.strictEqual(createStore({}).kind, 'memory');
  assert.strictEqual(createStore({}).persistent, false);
  const named = createStore({ DATABASE_URL: 'memory://one' });
  assert.strictEqual(named.persistent, true);
  assert.strictEqual(createStore({ DATABASE_URL: 'memory://one' }), named, 'a named test store is shared within the process');
  ok('DATABASE_URL picks the backend; without it nothing needs a database');

  await contract(createMemoryStore(), ok);

  // The memory store stays bounded.
  const small = createMemoryStore({ maxVideos: 10, maxLookups: 5 });
  for (let i = 0; i < 40; i++) await small.recordPlay('v', 'vid' + String(i).padStart(3, '0'), true, 'k' + i);
  const sm = await small.stats(1);
  assert.ok(sm.ratedVideos <= 10 && sm.lookupsWithVotes <= 5);
  ok('memory store is bounded');

  // ----- Postgres, with a scripted pool: migrations and retries without a database -----
  const calls = [];
  const fakePool = (applied, failures = []) => ({
    queries: calls,
    async query(text, params) { calls.push(['pool', text.replace(/\s+/g, ' ').trim().slice(0, 40), params]); const f = failures.shift(); if (f) throw f; return { rows: [{ ok: 1 }], rowCount: 1 }; },
    async connect() {
      return {
        async query(text, params) {
          calls.push(['client', text.replace(/\s+/g, ' ').trim().slice(0, 40), params]);
          if (/SELECT 1 FROM schema_migrations/.test(text)) return { rows: [], rowCount: applied.includes(params[0]) ? 1 : 0 };
          return { rows: [], rowCount: 0 };
        },
        release() { calls.push(['client', 'release']); },
      };
    },
    async end() {},
  });
  let pg = createPgStore({ url: 'x', pool: fakePool([]) });
  let init = await pg.init();
  assert.deepStrictEqual(init.applied, MIGRATIONS.map((_, i) => i + 1), 'a new database gets every migration');
  const text = calls.map((c) => c[1]).join('\n');
  assert.ok(/BEGIN/.test(text) && /COMMIT/.test(text) && /pg_advisory_xact_lock/.test(text) && !/pg_advisory_lock\b/.test(text), 'each migration runs in a transaction under a transaction-level advisory lock (safe behind Neon\'s pooler)');
  assert.ok(calls.some((c) => c[0] === 'client' && c[1] === 'release'), 'the migration connection is returned');
  calls.length = 0;
  pg = createPgStore({ url: 'x', pool: fakePool(MIGRATIONS.map((_, i) => i + 1)) });
  assert.deepStrictEqual((await pg.init()).applied, [], 'a migrated database is left alone');
  assert.ok(!calls.some((c) => /INSERT INTO schema_migrations/.test(String(c[1]))) && !calls.some((c) => /^\s*CREATE TABLE\s+rooms/i.test(String(c[1]))), 'nothing is re-applied');
  ok('migrations: applied once, in a transaction, under a lock');

  const dropped = Object.assign(new Error('Connection terminated unexpectedly'), {});
  pg = createPgStore({ url: 'x', pool: fakePool([], [dropped]), log: { warn() {} } });
  assert.strictEqual(await pg.ping(), true, 'one dropped connection (a Neon wake-up) is retried');
  pg = createPgStore({ url: 'x', pool: fakePool([], [dropped, dropped]), log: { warn() {} } });
  await assert.rejects(() => pg.ping(), /terminated/, 'a second failure is reported, not hidden');
  const syntax = Object.assign(new Error('syntax error'), { code: '42601' });
  const p2 = fakePool([], [syntax]); let n = 0; const origQuery = p2.query.bind(p2); p2.query = async (...a) => { n++; return origQuery(...a); };
  await assert.rejects(() => createPgStore({ url: 'x', pool: p2 }).ping(), /syntax/);
  assert.strictEqual(n, 1, 'real errors are not retried');
  ok('connection hiccups are retried once; real errors are not');

  if (process.env.TEST_DATABASE_URL) {
    const url = process.env.TEST_DATABASE_URL;
    const { Pool } = require('pg');
    const schema = 'rb_test_' + Date.now().toString(36);
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new Pool({ connectionString: url, max: 4, options: '-c search_path=' + schema });
    try {
      console.log('  Postgres contract run in schema ' + schema);
      await contract(createPgStore({ url, pool }), ok);
      await createPgStore({ url, pool }).init(); // a second start finds everything migrated
      ok('postgres: a restart finds the schema and data in place');
    } finally { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); }
  } else console.log('  (set TEST_DATABASE_URL to run the same contract against a real Postgres)');

  console.log(passed + ' store checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
