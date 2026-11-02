'use strict';
// Type-checks the server with TypeScript (JSDoc types, no build step).
// TypeScript is a dev-only tool: if it is not installed, say so and carry on, so running the app or its tests never needs it.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tsc = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) { console.log('typecheck skipped: run `npm install` to add TypeScript (dev only)'); process.exit(0); }
const r = spawnSync(process.execPath, [tsc, '-p', '.'], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
if (r.status === 0) console.log('typecheck ok');
process.exit(r.status === null ? 1 : r.status);
