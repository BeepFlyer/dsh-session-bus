import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const body = fs.readFileSync(path.join(here, '..', 'client-body.js'), 'utf8');
const load = new Function('React', body);
const api = load({
  createElement() {},
  useState() {},
  useEffect() {},
  useMemo() {},
  memo() {}
});

test('parses a plain bus header and strips it from the body', () => {
  const parsed = api.parseBusHeader('[session-bus | 小回 → 七巧板 | session | 19:35 | kind=notice]\nbody line');
  assert.deepEqual(parsed, { sender: '小回', kind: 'notice', ref: '', mode: 'queue', body: 'body line' });
});

test('parses kind, ref and the emergency flag', () => {
  const parsed = api.parseBusHeader('[session-bus | A → B | session | 09:00 | kind=handoff | ref=Whisperer#collider | 紧急]\ntext');
  assert.equal(parsed.kind, 'handoff');
  assert.equal(parsed.ref, 'Whisperer#collider');
  assert.equal(parsed.mode, 'steer');
});

test('strips trailing steer/abort/bus markers from the body', () => {
  const abort = api.parseBusHeader('[session-bus | A → B | session | 09:00 | kind=decision]\nstop\n[abort] 硬中止');
  assert.equal(abort.mode, 'abort');
  assert.equal(abort.body, 'stop');

  const normal = api.parseBusHeader('[session-bus | A → B | session | 09:00 | kind=notice]\nhello\n[bus] target is idle');
  assert.equal(normal.mode, 'queue');
  assert.equal(normal.body, 'hello');
});

test('ignores non-bus messages', () => {
  assert.equal(api.parseBusHeader('Team message from <name>: hi'), null);
  assert.equal(api.parseBusHeader('just a user message'), null);
  assert.equal(api.parseBusHeader(''), null);
});
