// dsh-session-bus — Host half.
// P0: storage + matching + guarded delivery + 5 tools + loopback/token HTTP.
// P1: admin API (settings UI backend), 3s signal windows, startup sweep (stale 24h),
//     dynamic limits, optional HMAC + timestamp replay protection.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 存储目录优先级：BUS_DIR 环境变量 > ~/.dsh/session-bus。不要把个人路径写死进仓库。
const BUS_DIR = process.env.BUS_DIR || path.join(os.homedir(), '.dsh', 'session-bus');
const INBOX_DIR = path.join(BUS_DIR, 'inbox');
const AGENTS_FILE = path.join(BUS_DIR, 'agents.json');
const WAITING_FILE = path.join(BUS_DIR, 'waiting.json');
const DELIVERIES_FILE = path.join(BUS_DIR, 'deliveries.jsonl');
const SETTINGS_FILE = path.join(BUS_DIR, 'settings.json');
const TOKEN_FILE = path.join(here, 'token.txt');

const BASE = '/api/session-bus';
const PUBLIC_PATHS = [BASE + '/signal', BASE + '/deliver', BASE + '/agents', BASE + '/waiting', BASE + '/log', BASE + '/admin'];
const ADMIN_PATH = '/api/session-bus-admin';
const WINDOW_MS = 3000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const HMAC_SKEW_SECONDS = 300;
const MAX_BODY = 256 * 1024;

const DEFAULT_SETTINGS = {
  maxHop: 3,
  maxPerMinute: 10,
  minIntervalMs: 5000,
  defaultTtlSeconds: 1800,
  hmacEnabled: false,
  hmacSecret: null
};

const recentDeliveries = [];
const lastBySession = new Map();
const windows = new Map();
let writeChain = Promise.resolve();
let settingsCache = { mtimeMs: -1, value: null };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withStoreLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function ensureStore() {
  mkdirSync(INBOX_DIR, { recursive: true });
  if (!existsSync(AGENTS_FILE)) writeFileSync(AGENTS_FILE, JSON.stringify({ version: 1, agents: [] }, null, 2) + '\n', 'utf8');
  if (!existsSync(WAITING_FILE)) writeFileSync(WAITING_FILE, JSON.stringify({ version: 1, waiting: [] }, null, 2) + '\n', 'utf8');
  if (!existsSync(DELIVERIES_FILE)) writeFileSync(DELIVERIES_FILE, '', 'utf8');
  if (!existsSync(SETTINGS_FILE)) writeFileSync(SETTINGS_FILE, JSON.stringify({ version: 1, ...DEFAULT_SETTINGS }, null, 2) + '\n', 'utf8');
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function readAgents() {
  const value = readJson(AGENTS_FILE, { version: 1, agents: [] });
  return Array.isArray(value.agents) ? value : { version: 1, agents: [] };
}

function writeAgents(agents) {
  writeFileSync(AGENTS_FILE, JSON.stringify({ version: 1, agents }, null, 2) + '\n', 'utf8');
}

function readWaiting() {
  const value = readJson(WAITING_FILE, { version: 1, waiting: [] });
  return Array.isArray(value.waiting) ? value : { version: 1, waiting: [] };
}

function writeWaiting(value) {
  writeFileSync(WAITING_FILE, JSON.stringify({ version: 1, waiting: value }, null, 2) + '\n', 'utf8');
}

function readSettings() {
  try {
    const stat = statSync(SETTINGS_FILE);
    if (settingsCache.value !== null && settingsCache.mtimeMs === stat.mtimeMs) return settingsCache.value;
    const parsed = readJson(SETTINGS_FILE, {});
    const next = { ...DEFAULT_SETTINGS, ...parsed };
    delete next.version;
    next.maxHop = clampNumber(next.maxHop, 0, 10, DEFAULT_SETTINGS.maxHop);
    next.maxPerMinute = clampNumber(next.maxPerMinute, 1, 120, DEFAULT_SETTINGS.maxPerMinute);
    next.minIntervalMs = clampNumber(next.minIntervalMs, 0, 60000, DEFAULT_SETTINGS.minIntervalMs);
    next.defaultTtlSeconds = clampNumber(next.defaultTtlSeconds, 60, 86400, DEFAULT_SETTINGS.defaultTtlSeconds);
    next.hmacEnabled = next.hmacEnabled === true;
    next.hmacSecret = typeof next.hmacSecret === 'string' && next.hmacSecret !== '' ? next.hmacSecret : null;
    settingsCache = { mtimeMs: stat.mtimeMs, value: next };
    return next;
  } catch (_error) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const current = readSettings();
  const next = { ...current, ...patch };
  next.maxHop = clampNumber(next.maxHop, 0, 10, DEFAULT_SETTINGS.maxHop);
  next.maxPerMinute = clampNumber(next.maxPerMinute, 1, 120, DEFAULT_SETTINGS.maxPerMinute);
  next.minIntervalMs = clampNumber(next.minIntervalMs, 0, 60000, DEFAULT_SETTINGS.minIntervalMs);
  next.defaultTtlSeconds = clampNumber(next.defaultTtlSeconds, 60, 86400, DEFAULT_SETTINGS.defaultTtlSeconds);
  next.hmacEnabled = next.hmacEnabled === true;
  next.hmacSecret = typeof next.hmacSecret === 'string' && next.hmacSecret !== '' ? next.hmacSecret : null;
  writeFileSync(SETTINGS_FILE, JSON.stringify({ version: 1, ...next }, null, 2) + '\n', 'utf8');
  settingsCache = { mtimeMs: -1, value: null };
  return readSettings();
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function appendAudit(entry) {
  if (entry.at === null || entry.at === undefined) entry.at = isoNow(new Date());
  try {
    appendFileSync(DELIVERIES_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_error) {}
}

function localTime(date) {
  return date.toTimeString().slice(0, 5);
}

function isoNow(date) {
  const d = date || new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + sign + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60)
  );
}

function readToken() {
  const fromEnv = process.env.BUS_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (_error) {
    return null;
  }
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 'bad-request' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw Object.assign(new Error('body is not JSON'), { code: 'bad-request' });
  }
}

function matches(match, text, from, type) {
  if (match === undefined || match === null) return true;
  if (match.any === true) return true;
  if (match.ownerOnly === true && from !== 'owner') return false;
  if (match.from !== undefined && String(match.from) !== String(from)) return false;
  if (match.type !== undefined && String(match.type) !== String(type)) return false;
  if (Array.isArray(match.textContains) && match.textContains.length > 0) {
    const hit = match.textContains.some((needle) => String(needle) !== '' && text.includes(String(needle)));
    if (!hit) return false;
  }
  if (typeof match.regex === 'string' && match.regex !== '') {
    try {
      if (!new RegExp(match.regex, 'u').test(text)) return false;
    } catch (_error) {
      return false;
    }
  }
  return true;
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

function findAgent(agents, sessionId) {
  return agents.find((agent) => agent.sessionId === sessionId);
}

// 默认全放开：allowFrom 缺失 / 空数组 / 含 "*" 都放行；只有显式白名单才做匹配。
function allows(from, target) {
  const allow = target && Array.isArray(target.allowFrom) ? target.allowFrom : [];
  if (allow.length === 0 || allow.includes('*')) return true;
  if (from === 'owner') return allow.includes('owner');
  return allow.includes(from);
}

function inboxPathFor(source, date) {
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  return path.join(INBOX_DIR, source + '-' + day + '.jsonl');
}

function verifyHmac(req, rawBody, settings) {
  if (settings.hmacEnabled !== true) return { ok: true };
  const timestamp = String(req.headers['x-bus-timestamp'] || '');
  const signature = String(req.headers['x-bus-signature'] || '');
  if (timestamp === '' || signature === '') return { ok: false, reason: 'hmac-missing' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > HMAC_SKEW_SECONDS) return { ok: false, reason: 'hmac-stale' };
  const secret = settings.hmacSecret || readToken() || '';
  if (secret === '') return { ok: false, reason: 'hmac-no-secret' };
  const expected = createHmac('sha256', secret).update(timestamp + '\n' + rawBody).digest();
  let provided;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch (_error) {
    return { ok: false, reason: 'hmac-bad-signature' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { ok: false, reason: 'hmac-bad-signature' };
  return { ok: true };
}

export function apply(ctx) {
  ensureStore();

  const sweepNow = async () => {
    const now = Date.now();
    let archived = new Set();
    try {
      const registry = ctx.get('workspaceRegistry');
      if (registry && Array.isArray(registry.archivedSessionIds)) archived = new Set(registry.archivedSessionIds);
    } catch (_error) {}
    await withStoreLock(() => {
      const current = readWaiting().waiting;
      const next = [];
      for (const item of current) {
        if (Date.parse(item.expiresAt) <= now) {
          appendAudit({ at: null, eventId: null, sessionId: item.sessionId, hop: 0, ok: false, accepted: false, flushed: false, reason: 'ttl-expired', source: item.source || null });
          continue;
        }
        if (item.stale === true) {
          const staleAt = Date.parse(item.staleAt || item.expiresAt);
          if (Number.isFinite(staleAt) && now - staleAt > STALE_TTL_MS) {
            appendAudit({ at: null, eventId: null, sessionId: item.sessionId, hop: 0, ok: false, accepted: false, flushed: false, reason: 'stale-removed', source: item.source || null });
            continue;
          }
        } else if (archived.has(item.sessionId)) {
          item.stale = true;
          item.staleAt = isoNow(new Date());
        }
        next.push(item);
      }
      if (JSON.stringify(next) !== JSON.stringify(current)) writeWaiting(next);
    });
  };

  ctx.inject(['webServer', 'connection', 'tools', 'sessions', 'sessionController'], (c) => {
    const controller = c.sessionController;
    const sessions = c.sessions;
    const log = (message) => {
      try {
        c.logger?.info?.('[session-bus] ' + message);
      } catch (_error) {}
    };

    // External processes (the Feishu bridge) discover this Host here: the listen
    // port changes on every restart, so origin.txt is the only stable entry.
    let originTimer = null;
    const originFile = path.join(BUS_DIR, 'origin.txt');
    function publishOrigin(attempt) {
      originTimer = null;
      try {
        const origin = c.webServer.getOrigin();
        if (typeof origin === 'string' && origin.startsWith('http')) {
          writeFileSync(originFile, origin + '\n', 'utf8');
          log('origin published: ' + origin + ' -> ' + originFile);
          return;
        }
      } catch (_error) {}
      if (attempt < 300) {
        originTimer = setTimeout(() => publishOrigin(attempt + 1), 1000);
        try {
          originTimer.unref?.();
        } catch (_error) {}
      }
    }

    async function reserveSlot(sessionId) {
      const settings = readSettings();
      const deadline = Date.now() + 60000;
      for (;;) {
        const now = Date.now();
        while (recentDeliveries.length > 0 && now - recentDeliveries[0] > 60000) recentDeliveries.shift();
        const last = lastBySession.get(sessionId) || 0;
        if (recentDeliveries.length < settings.maxPerMinute && now - last >= settings.minIntervalMs) {
          recentDeliveries.push(now);
          lastBySession.set(sessionId, now);
          return;
        }
        if (Date.now() >= deadline) throw Object.assign(new Error('rate-limited'), { code: 'rate-limited' });
        await delay(Math.max(50, Math.min(250, settings.minIntervalMs - (now - last))));
      }
    }

    async function deliverOnce(options) {
      const settings = readSettings();
      const entry = {
        at: null,
        eventId: options.eventId || null,
        sessionId: options.sessionId,
        hop: options.hop,
        ok: false,
        accepted: false,
        flushed: false,
        reason: null,
        source: options.source || null,
        renderSource: options.from === 'owner' ? 'webhook' : 'agent-message'
      };
      if (options.hop > settings.maxHop) {
        entry.reason = 'hop-exceeded';
        appendAudit(entry);
        return entry;
      }
      const agents = readAgents().agents;
      const target = findAgent(agents, options.sessionId);
      if (!allows(options.from, target)) {
        entry.reason = 'permission-denied';
        appendAudit(entry);
        return entry;
      }
      try {
        await reserveSlot(options.sessionId);
      } catch (error) {
        entry.reason = (error && error.code) || 'rate-limited';
        appendAudit(entry);
        return entry;
      }
      try {
        const found = await controller.resolveAgent(options.sessionId);
        if (found && found.error) throw Object.assign(new Error(found.error.message || 'resolve failed'), { code: found.error.code || 'resolve-failed' });
        const agent = found && found.agent;
        if (!agent) throw Object.assign(new Error('agent unavailable'), { code: 'resolve-failed' });
        // 会话→会话用 relay（客户端渲染成「来自会话 X」的上下文行）；
        // 外部/owner 事件用 webhook notice（客户端渲染成带摘要的注入行）。
        const relaySource = options.from !== 'owner';
        const source = relaySource
          ? { kind: 'agent-message', form: 'relay', senderSessionId: options.from }
          : {
              kind: 'webhook',
              form: 'notice',
              provider: 'session-bus',
              source: String(options.source || 'owner'),
              deliveryId: String(options.eventId || randomUUID()),
              ruleId: 'session-bus',
              summary: options.text.replace(/\s+/g, ' ').slice(0, 120)
            };
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: options.text }],
          source
        });
        entry.accepted = true;
        entry.flushed = (await sessions.flush(agent.session)) === true;
        entry.ok = entry.flushed === true;
        if (!entry.ok) entry.reason = 'flush-failed';
      } catch (error) {
        entry.reason = (error && error.code) || 'prompt-failed';
        if (entry.reason === 'prompt-failed') entry.reason = 'prompt-failed: ' + String((error && error.message) || error);
      }
      appendAudit(entry);
      return entry;
    }

    // ---- 3s signal windows: one window = one event with refs ----
    async function finalizeWindow(window) {
      windows.delete(window.key);
      const observations = window.observations.slice();
      if (observations.length === 0) return;
      const first = observations[0];
      const eventId = 'evt-' + randomUUID();
      const refs = observations.map((obs) => obs.observationId);
      const text = observations.map((obs) => obs.text).filter((value) => value !== '').join('\n');
      const type = observations.every((obs) => obs.type === first.type) ? first.type : 'message';
      const from = observations.every((obs) => obs.from === first.from) ? first.from : first.from;
      const settings = readSettings();
      const vars = {
        count: observations.length,
        inboxPath: first.inboxPath,
        source: first.source,
        sender: from,
        firstText: text.slice(0, 50),
        digest: text.slice(0, 120),
        time: localTime(new Date()),
        eventId,
        refs: refs.join(',')
      };
      const agents = readAgents().agents;
      const waiting = readWaiting().waiting;
      // 同一 event 对同一 sessionId 最多投递一次：
      // 等待项优先于长期订阅；同类规则按创建时间早的优先。
      const waitingMatches = [];
      for (const item of waiting) {
        if (item.sessionId === undefined || item.stale === true) continue;
        if (item.source !== undefined && String(item.source) !== String(first.source)) continue;
        if (!matches(item.match, text, from, type)) continue;
        const owner = findAgent(agents, item.sessionId);
        waitingMatches.push({
          sessionId: item.sessionId,
          name: (owner && owner.name) || item.sessionId,
          template: '你在等的 {source} 事件到了（{count} 条），见 {inboxPath}。',
          waitingId: item.id || null,
          createdAt: item.createdAt || ''
        });
      }
      waitingMatches.sort((left, right) => {
        const a = Date.parse(left.createdAt);
        const b = Date.parse(right.createdAt);
        if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
        if (!Number.isFinite(a)) return 1;
        if (!Number.isFinite(b)) return -1;
        return a - b;
      });
      const bySession = new Map();
      for (const entry of waitingMatches) {
        if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, entry);
      }
      for (const agent of agents) {
        if (agent.enabled === false) continue;
        const subs = Array.isArray(agent.subscriptions) ? agent.subscriptions : [];
        for (const sub of subs) {
          if (bySession.has(agent.sessionId)) continue;
          if (!matches(sub.match, text, from, type)) continue;
          bySession.set(agent.sessionId, {
            sessionId: agent.sessionId,
            name: agent.name || agent.sessionId,
            template: sub.template || '来源 {source} 有 {count} 条新观察，见 {inboxPath}。',
            waitingId: null
          });
        }
      }
      const plan = Array.from(bySession.values());
      const results = [];
      for (const target of plan) {
        const header = '[session-bus | ' + first.source + ' → ' + target.name + ' | ' + type + ' | ' + localTime(new Date()) + ']';
        const entry = await deliverOnce({
          eventId,
          sessionId: target.sessionId,
          from,
          source: first.source,
          hop: 0,
          text: header + '\n' + renderTemplate(target.template, vars)
        });
        results.push(entry);
        if (entry.ok && target.waitingId !== null) {
          await withStoreLock(() => writeWaiting(readWaiting().waiting.filter((item) => item.id !== target.waitingId)));
        }
      }
      log('window ' + eventId + ' closed: ' + String(observations.length) + ' observation(s), ' + String(results.filter((r) => r.ok).length) + ' delivery(ies)');
      void settings;
    }

    function receiveObservation(observation) {
      const key = String(observation.source) + '|' + String(observation.from);
      let window = windows.get(key);
      if (!window) {
        window = { key, observations: [], closesAt: Date.now() + WINDOW_MS, timer: null };
        windows.set(key, window);
      }
      window.observations.push(observation);
      if (window.timer === null) {
        window.timer = setTimeout(() => {
          finalizeWindow(window).catch((error) => log('window failed: ' + String((error && error.message) || error)));
        }, WINDOW_MS);
        try {
          window.timer.unref?.();
        } catch (_error) {}
      }
      return window;
    }

    // ---- admin operations shared by the browser admin API and the token API ----
    function adminListAgents() {
      const agents = readAgents().agents;
      const waiting = readWaiting().waiting;
      return agents.map((agent) => ({
        ...agent,
        waitingCount: waiting.filter((item) => item.sessionId === agent.sessionId).length
      }));
    }

    function normalizeAgent(input) {
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
      if (sessionId === '') throw Object.assign(new Error('sessionId required'), { code: 'bad-request' });
      const agent = {
        sessionId,
        name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : sessionId,
        role: typeof input.role === 'string' ? input.role : '',
        knows: Array.isArray(input.knows) ? input.knows.map(String).filter(Boolean) : [],
        allowFrom: Array.isArray(input.allowFrom) ? input.allowFrom.map(String).filter(Boolean) : ['owner'],
        enabled: input.enabled !== false,
        subscriptions: Array.isArray(input.subscriptions) ? input.subscriptions : [],
        updatedAt: isoNow(new Date())
      };
      return agent;
    }

    async function adminAction(action, payload) {
      if (action === 'listAgents') return { agents: adminListAgents() };
      if (action === 'listWaiting') return { waiting: readWaiting().waiting };
      if (action === 'listSettings') return { settings: readSettings() };
      if (action === 'listLog') {
        const limit = Math.max(1, Math.min(200, Number(payload && payload.limit) || 50));
        let lines = [];
        try {
          lines = readFileSync(DELIVERIES_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
        } catch (_error) {}
        return { entries: lines.map((line) => { try { return JSON.parse(line); } catch (_error) { return { raw: line }; } }) };
      }
      if (action === 'saveAgent') {
        const agent = normalizeAgent(payload && payload.agent ? payload.agent : payload || {});
        await withStoreLock(() => {
          const agents = readAgents().agents;
          const index = agents.findIndex((candidate) => candidate.sessionId === agent.sessionId);
          if (index >= 0) agents[index] = { ...agents[index], ...agent };
          else agents.push(agent);
          writeAgents(agents);
        });
        return { agent, agents: adminListAgents() };
      }
      if (action === 'deleteAgent') {
        const sessionId = String(payload && payload.sessionId ? payload.sessionId : '').trim();
        if (sessionId === '') throw Object.assign(new Error('sessionId required'), { code: 'bad-request' });
        await withStoreLock(() => {
          writeAgents(readAgents().agents.filter((agent) => agent.sessionId !== sessionId));
          writeWaiting(readWaiting().waiting.filter((item) => item.sessionId !== sessionId));
        });
        return { deleted: sessionId, agents: adminListAgents() };
      }
      if (action === 'toggleAgent') {
        const sessionId = String(payload && payload.sessionId ? payload.sessionId : '').trim();
        const enabled = payload && payload.enabled === true;
        await withStoreLock(() => {
          const agents = readAgents().agents;
          const agent = agents.find((candidate) => candidate.sessionId === sessionId);
          if (agent) agent.enabled = enabled;
          writeAgents(agents);
        });
        return { agents: adminListAgents() };
      }
      if (action === 'removeWaiting') {
        const id = String(payload && payload.id ? payload.id : '').trim();
        await withStoreLock(() => writeWaiting(readWaiting().waiting.filter((item) => item.id !== id)));
        return { removed: id, waiting: readWaiting().waiting };
      }
      if (action === 'saveSettings') {
        const settings = writeSettings(payload && payload.settings ? payload.settings : {});
        return { settings };
      }
      if (action === 'flushWindows') {
        for (const window of Array.from(windows.values())) {
          if (window.timer !== null) clearTimeout(window.timer);
          window.timer = null;
          await finalizeWindow(window);
        }
        return { flushed: true };
      }
      if (action === 'sweep') {
        await sweepNow();
        return { waiting: readWaiting().waiting };
      }
      throw Object.assign(new Error('unknown action: ' + String(action)), { code: 'bad-request' });
    }

    // ---- public HTTP (loopback + shared token) ----
    const publicHandler = async (req, res) => {
      const remote = req.socket?.remoteAddress;
      if (!isLoopback(remote)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' });
        return;
      }
      const expected = readToken();
      if (expected === null) {
        sendJson(res, 500, { ok: false, error: 'token-not-configured' });
        return;
      }
      if (String(req.headers['x-bus-token'] ?? '') !== expected) {
        sendJson(res, 401, { ok: false, error: 'bad-token' });
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const route = url.pathname;
      try {
        const settings = readSettings();
        if (route === BASE + '/agents' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, agents: adminListAgents() });
          return;
        }
        if (route === BASE + '/waiting' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, waiting: readWaiting().waiting });
          return;
        }
        if (route === BASE + '/log' && req.method === 'GET') {
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
          const result = await adminAction('listLog', { limit });
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        if (route === BASE + '/admin' && req.method === 'POST') {
          const rawBody = await readRawBody(req);
          const hmac = verifyHmac(req, rawBody, settings);
          if (!hmac.ok) {
            sendJson(res, 401, { ok: false, error: hmac.reason });
            return;
          }
          const payload = parseJson(rawBody);
          const result = await adminAction(payload.action, payload);
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        if (route === BASE + '/signal' && req.method === 'POST') {
          const rawBody = await readRawBody(req);
          const hmac = verifyHmac(req, rawBody, settings);
          if (!hmac.ok) {
            sendJson(res, 401, { ok: false, error: hmac.reason });
            return;
          }
          const payload = parseJson(rawBody);
          if (typeof payload.source !== 'string' || payload.source === '') {
            sendJson(res, 400, { ok: false, error: 'source-required' });
            return;
          }
          const observationId = 'obs-' + randomUUID();
          const now = new Date();
          const observation = {
            observationId,
            source: String(payload.source),
            type: String(payload.type || payload.kind || 'message'),
            from: String(payload.from || 'owner'),
            text: typeof payload.text === 'string' ? payload.text : '',
            at: isoNow(now),
            inboxPath: inboxPathFor(String(payload.source), now)
          };
          appendFileSync(observation.inboxPath, JSON.stringify(observation) + '\n', 'utf8');
          const window = receiveObservation(observation);
          sendJson(res, 200, {
            ok: true,
            observationId,
            windowClosesAt: isoNow(new Date(window.closesAt)),
            windowSize: window.observations.length
          });
          return;
        }
        if (route === BASE + '/deliver' && req.method === 'POST') {
          const rawBody = await readRawBody(req);
          const hmac = verifyHmac(req, rawBody, settings);
          if (!hmac.ok) {
            sendJson(res, 401, { ok: false, error: hmac.reason });
            return;
          }
          const payload = parseJson(rawBody);
          const sessionId = String(payload.sessionId || '').trim();
          const text = typeof payload.text === 'string' ? payload.text.trim() : '';
          if (sessionId === '' || text === '') {
            sendJson(res, 400, { ok: false, error: 'sessionId-and-text-required' });
            return;
          }
          const agents = readAgents().agents;
          const target = findAgent(agents, sessionId);
          const name = (target && target.name) || sessionId;
          const header = '[session-bus | owner → ' + name + ' | direct | ' + localTime(new Date()) + ']';
          const entry = await deliverOnce({
            eventId: 'evt-' + randomUUID(),
            sessionId,
            from: 'owner',
            source: 'owner',
            hop: 0,
            text: header + '\n' + text
          });
          sendJson(res, entry.ok ? 200 : 409, { ok: entry.ok, ...entry });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not-found' });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error), code: (error && error.code) || null });
      }
    };

    // ---- browser admin API (same-origin cookie fence via connection.fetch) ----
    const adminHandler = async (request) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const action = url.searchParams.get('action') || '';
        if (request.method === 'GET') {
          const result = await adminAction(action === '' ? 'listAgents' : action, {});
          return jsonResponse({ ok: true, ...result });
        }
        if (request.method === 'POST') {
          const raw = await request.text();
          const payload = parseJson(raw);
          const result = await adminAction(payload.action, payload);
          return jsonResponse({ ok: true, ...result });
        }
        return jsonResponse({ ok: false, error: 'method-not-allowed' }, 405);
      } catch (error) {
        return jsonResponse({ ok: false, error: String((error && error.message) || error), code: (error && error.code) || null }, 400);
      }
    };

    const output = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    };

    function callerOf(exec) {
      const agent = exec && exec.agent;
      return agent && typeof agent.id === 'string' ? agent.id : null;
    }

    function callerName(sessionId) {
      const agent = findAgent(readAgents().agents, sessionId);
      return (agent && agent.name) || sessionId;
    }

    const listAgentsTool = {
      name: 'bus_list_agents',
      description: 'List the DSH sessions registered on the local session bus, with role, capabilities, allowFrom, and pending waits.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      execute: async () => ({ agents: adminListAgents().map(({ sessionId, name, role, knows, enabled, allowFrom, waitingCount }) => ({ sessionId, name, role, knows, enabled, allowFrom, waitingCount })) })
    };

    const deliverTool = {
      name: 'bus_deliver',
      description: 'Deliver a short message to another registered DSH session through the session bus. It arrives as a normal user message, queued behind any running turn; pass a file path instead of a long payload.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Target session id (see bus_list_agents).' },
          text: { type: 'string', description: 'Short message or a pointer to a workspace file.' },
          hop: { type: 'number', description: 'Current hop count of this wake-up chain; omit for a fresh delivery.' }
        },
        required: ['sessionId', 'text'],
        additionalProperties: false
      },
      output,
      execute: async (args, exec) => {
        const caller = callerOf(exec);
        if (caller === null) throw new Error('bus_deliver: no calling session');
        const sessionId = String(args && args.sessionId ? args.sessionId : '').trim();
        const text = String(args && args.text ? args.text : '').trim();
        if (sessionId === '' || text === '') throw new Error('bus_deliver: sessionId and text are required');
        const hop = Number.isFinite(Number(args.hop)) ? Number(args.hop) + 1 : 1;
        const header = '[session-bus | ' + callerName(caller) + ' → ' + callerName(sessionId) + ' | session | ' + localTime(new Date()) + ']';
        const entry = await deliverOnce({
          eventId: 'evt-' + randomUUID(),
          sessionId,
          from: caller,
          source: 'session',
          hop,
          text: header + '\n' + text
        });
        if (!entry.ok) throw new Error('bus_deliver failed: ' + String(entry.reason || 'unknown'));
        return { ok: true, sessionId, hop, request: entry };
      }
    };

    const waitTool = {
      name: 'bus_wait_for',
      description: 'Register a one-shot wait on the session bus: when a matching external signal arrives, this session is woken with a short pointer message. Waits expire automatically.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Signal source to wait for, e.g. feishu.' },
          match: { type: 'object', description: 'Match rules; omitted fields do not restrict. Example: {ownerOnly:true, type:"image", textContains:["鲸鱼"]}.', additionalProperties: true },
          reason: { type: 'string', description: 'Human-readable reason shown in the settings page and the wake-up message.' },
          ttlSeconds: { type: 'number', description: 'Lifetime in seconds; defaults to 1800.' },
          consume: { type: 'string', enum: ['once'], description: 'Consumption mode; only once is supported.' }
        },
        required: ['source'],
        additionalProperties: false
      },
      output,
      execute: async (args, exec) => {
        const caller = callerOf(exec);
        if (caller === null) throw new Error('bus_wait_for: no calling session');
        const source = String(args && args.source ? args.source : '').trim();
        if (source === '') throw new Error('bus_wait_for: source is required');
        const settings = readSettings();
        const ttl = Number(args.ttlSeconds) > 0 ? Number(args.ttlSeconds) : settings.defaultTtlSeconds;
        const now = new Date();
        const item = {
          id: 'wait-' + randomUUID(),
          sessionId: caller,
          reason: typeof args.reason === 'string' ? args.reason : null,
          source,
          match: args.match && typeof args.match === 'object' ? args.match : {},
          createdAt: isoNow(now),
          expiresAt: isoNow(new Date(now.getTime() + ttl * 1000)),
          consume: 'once',
          stale: false
        };
        await withStoreLock(() => {
          const waiting = readWaiting().waiting;
          waiting.push(item);
          writeWaiting(waiting);
        });
        return { ok: true, item };
      }
    };

    const listWaitingTool = {
      name: 'bus_list_waiting',
      description: 'List the waits this session registered on the session bus.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      execute: async (_args, exec) => {
        const caller = callerOf(exec);
        if (caller === null) throw new Error('bus_list_waiting: no calling session');
        return { waiting: readWaiting().waiting.filter((item) => item.sessionId === caller) };
      }
    };

    const clearWaitingTool = {
      name: 'bus_clear_waiting',
      description: 'Clear waits registered by this session. Omit id to clear all of them.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Specific wait id; omitted clears every wait of this session.' } }, additionalProperties: false },
      output,
      execute: async (args, exec) => {
        const caller = callerOf(exec);
        if (caller === null) throw new Error('bus_clear_waiting: no calling session');
        const id = typeof args.id === 'string' ? args.id : null;
        let cleared = 0;
        await withStoreLock(() => {
          const next = readWaiting().waiting.filter((item) => {
            const mine = item.sessionId === caller;
            const selected = id === null ? mine : mine && item.id === id;
            if (selected) cleared += 1;
            return !selected;
          });
          writeWaiting(next);
        });
        return { ok: true, cleared };
      }
    };

    c.effect(() => {
      const disposers = PUBLIC_PATHS.map((routePath) => c.webServer.register({ kind: 'exact', path: routePath, handler: publicHandler }));
      disposers.push(c.connection.fetch.register({ path: ADMIN_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: adminHandler }));
      publishOrigin(0);
      return () => {
        if (originTimer !== null) {
          clearTimeout(originTimer);
          originTimer = null;
        }
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (_error) {}
        }
      };
    });
    c.effect(() => c.tools.register(listAgentsTool));
    c.effect(() => c.tools.register(deliverTool));
    c.effect(() => c.tools.register(waitTool));
    c.effect(() => c.tools.register(listWaitingTool));
    c.effect(() => c.tools.register(clearWaitingTool));
    c.effect(() => {
      const timer = setInterval(() => {
        sweepNow().catch((error) => log('sweep failed: ' + String((error && error.message) || error)));
      }, 60000);
      return () => clearInterval(timer);
    });
    sweepNow().catch((error) => log('startup sweep failed: ' + String((error && error.message) || error)));
    log('ready at ' + BASE + ' (store ' + BUS_DIR + ')');
  });
}
