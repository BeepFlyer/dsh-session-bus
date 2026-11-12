import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the bus store before importing the plugin (BUS_DIR is read at module load).
const busDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-bus-test-'));
process.env.BUS_DIR = busDir;
fs.writeFileSync(
  path.join(busDir, 'settings.json'),
  JSON.stringify({ version: 1, maxHop: 3, maxPerMinute: 100, minIntervalMs: 0, defaultTtlSeconds: 1800, hmacEnabled: false, hmacSecret: null }, null, 2) + '\n',
  'utf8'
);

const { apply } = await import('../index.js?test=' + Date.now());

const tools = new Map();
const effects = [];
const agents = new Map();

function fakeAgent(id, status) {
  const inbox = {
    nextTurn: [],
    nextStep: [],
    replace(messageId, message) {
      for (const list of [inbox.nextTurn, inbox.nextStep]) {
        const index = list.findIndex((candidate) => candidate.id === messageId);
        if (index >= 0) {
          list[index] = message;
          return true;
        }
      }
      return false;
    },
    remove(messageId) {
      for (const list of [inbox.nextTurn, inbox.nextStep]) {
        const index = list.findIndex((candidate) => candidate.id === messageId);
        if (index >= 0) {
          list.splice(index, 1);
          return true;
        }
      }
      return false;
    }
  };
  return {
    id,
    status,
    inbox,
    session: { id },
    followup(message) {
      inbox.nextTurn.push(message);
    },
    steer(message) {
      inbox.nextStep.push(message);
    },
    cancel() {}
  };
}

const c = {
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') effects.push(dispose);
    return dispose;
  },
  webServer: {
    register: () => () => {},
    getOrigin: () => 'http://127.0.0.1:12345'
  },
  connection: { fetch: { register: () => () => {} } },
  tools: {
    register(tool) {
      tools.set(tool.name, tool);
      return () => {};
    }
  },
  agents: { get: (id) => agents.get(id) },
  sessions: { flush: async () => true },
  sessionController: { resolveAgent: async (id) => ({ agent: agents.get(id) }) },
  logger: { info() {}, warn() {}, error() {} }
};

apply({ inject: (_names, callback) => callback(c), get: () => undefined });
await new Promise((resolve) => setTimeout(resolve, 30));

const caller = { agent: { id: 'session-a' } };

function peers() {
  return tools.get('bus_peers').execute({}, caller);
}

test('bus_register creates a peer with reason and audits it', async () => {
  const result = await tools.get('bus_register').execute(
    { sessionId: 'session-d', name: 'D', role: 'tester', reason: 'onboarding' },
    caller
  );
  assert.equal(result.outcome, 'created');
  assert.equal(result.target, 'session-d');
  const list = await peers();
  assert.ok(list.agents.some((agent) => agent.sessionId === 'session-d'));
  const audit = fs.readFileSync(path.join(busDir, 'state', 'registry.jsonl'), 'utf8');
  assert.match(audit, /"target":"session-d"/);
  assert.match(audit, /"reason":"onboarding"/);
});

test('bus_register rejects another session permission fields without force', async () => {
  await assert.rejects(
    tools.get('bus_register').execute({ sessionId: 'session-d', allowAbort: true, reason: 'try' }, caller),
    /requires force:true/
  );
});

test('bus_register accepts forced permission edits and renames with migration', async () => {
  const forced = await tools.get('bus_register').execute(
    { sessionId: 'session-d', allowAbort: true, force: true, reason: 'needed' },
    caller
  );
  assert.equal(forced.outcome, 'updated');
  assert.equal(forced.agent.allowAbort, true);

  const renamed = await tools.get('bus_register').execute(
    { sessionId: 'session-e', originalSessionId: 'session-d', name: 'E', force: true, reason: 'rebirth' },
    caller
  );
  assert.equal(renamed.outcome, 'renamed');
  const list = await peers();
  assert.ok(!list.agents.some((agent) => agent.sessionId === 'session-d'));
  assert.ok(list.agents.some((agent) => agent.sessionId === 'session-e'));
});

test('bus_register edits the caller itself when sessionId is omitted', async () => {
  const result = await tools.get('bus_register').execute({ name: 'A', role: 'self' }, caller);
  assert.equal(result.outcome, 'created');
  assert.equal(result.target, 'session-a');
});

test('queue delivery merges into one block per sender', async () => {
  agents.set('session-b', fakeAgent('session-b', 'idle'));
  const first = await tools.get('bus_deliver').execute({ sessionId: 'session-b', text: 'hello' }, caller);
  assert.equal(first.ok, true);
  assert.equal(first.merged, false);
  assert.equal(first.inboxCount, 1);

  const second = await tools.get('bus_deliver').execute({ sessionId: 'session-b', text: 'world' }, caller);
  assert.equal(second.ok, true);
  assert.equal(second.merged, true);
  const inbox = agents.get('session-b').inbox.nextTurn;
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].content[0].text, /hello/);
  assert.match(inbox[0].content[0].text, /world/);
});

test('steer goes to next-step; abort without allowAbort degrades to queue', async () => {
  const target = agents.get('session-b');
  target.status = 'running';
  const steer = await tools.get('bus_deliver').execute(
    { sessionId: 'session-b', text: 'steer me', mode: 'steer' },
    caller
  );
  assert.equal(steer.mode, 'steer');
  assert.equal(target.inbox.nextStep.length, 1);

  const abort = await tools.get('bus_deliver').execute(
    { sessionId: 'session-b', text: 'stop', mode: 'abort', reason: 'test' },
    caller
  );
  assert.equal(abort.mode, 'queue');
  assert.match(String(abort.note), /abort is disabled/);
});

test('unregistered delivery is recorded but resolves nothing', async () => {
  await assert.rejects(
    tools.get('bus_deliver').execute({ sessionId: 'session-missing', text: 'hi' }, caller),
    /bus_deliver failed/
  );
});

test.after(() => {
  for (const dispose of effects) {
    try {
      dispose();
    } catch (_error) {}
  }
  fs.rmSync(busDir, { recursive: true, force: true });
});
