// Runs the sidecar's tests (npm test): every test/*.test.mjs, each in its own process, the original ones first in
// their old order and any newer file after them by name, stopping at the first failure. A new test file is picked up
// without touching package.json, so changes that each add one don't collide there.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIRST = [
  'reply.test.mjs',
  'store.test.mjs',
  'brain.test.mjs',
  'pointing.test.mjs',
  'safety.test.mjs',
  'voicemodel.test.mjs',
  'agentstream.test.mjs',
  'claudecode.test.mjs',
  'providers.test.mjs',
  'toolschema.test.mjs',
  'hands.test.mjs',
  'toolplay.test.mjs',
  'marks.test.mjs',
  'draw.test.mjs',
  'markdown.test.mjs',
  'caret.test.mjs',
  'intro.test.mjs',
  'speech.test.mjs',
  'fish.test.mjs',
  'speaker.test.mjs',
  'secrets.test.mjs',
  'looks.test.mjs',
  'activity.test.mjs',
  'prompt.test.mjs',
  'platform.test.mjs',
  'hitrects.test.mjs',
  'askbar.test.mjs',
  'diagnostics.test.mjs',
  'errors.test.mjs',
];
const all = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
const order = [...FIRST.filter((f) => all.includes(f)), ...all.filter((f) => !FIRST.includes(f)).sort()];
for (const f of order) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\n${f} failed`); process.exit(r.status ?? 1); }
}
