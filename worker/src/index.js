// World Cup 2026 push notification Worker.
//
// HTTP endpoints (CORS-enabled for ALLOWED_ORIGIN):
//   POST /subscribe   { subscription: PushSubscription, prefs?: Prefs }
//   POST /prefs       { endpoint, prefs }      — updates prefs on existing sub
//   POST /unsubscribe { endpoint }
//   GET  /health
//
// Cron handler (every minute):
//   - Poll ESPN scoreboard for the active tournament window.
//   - Pre-game: ~30 min before kickoff (idempotent via pregame:<id> marker).
//   - Diff each event against KV state: kickoff / goal / final whistle.
//   - Fan out to each subscriber whose prefs include the event type.

// Web Push delivery via @block65/webcrypto-web-push (pure Web Crypto API).
// We can't use the `web-push` npm package on Cloudflare Workers because it
// depends on Node's crypto.createECDH, which the unenv polyfill exposes via
// nodejs_compat as "not implemented" — every send would throw silently.
import { buildPushPayload } from '@block65/webcrypto-web-push';

function vapidKeys(env) {
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
}

const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

const PREGAME_MIN_MS = 25 * 60 * 1000;
const PREGAME_MAX_MS = 35 * 60 * 1000;

function defaultPrefs() {
  return { preGame: true, kickoff: true, goal: true, final: true };
}

function sanitizePrefs(p) {
  const def = defaultPrefs();
  if (!p || typeof p !== 'object') return def;
  return {
    preGame: typeof p.preGame === 'boolean' ? p.preGame : def.preGame,
    kickoff: typeof p.kickoff === 'boolean' ? p.kickoff : def.kickoff,
    goal: typeof p.goal === 'boolean' ? p.goal : def.goal,
    final: typeof p.final === 'boolean' ? p.final : def.final,
  };
}

// Older subs were stored as the raw PushSubscription; new ones are
// `{ subscription, prefs }`. Coerce on read so the rest of the code
// can treat both the same.
function parseSubscriberRecord(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed && parsed.subscription && parsed.subscription.endpoint) {
    return { subscription: parsed.subscription, prefs: sanitizePrefs(parsed.prefs) };
  }
  if (parsed && parsed.endpoint && parsed.keys) {
    return { subscription: parsed, prefs: defaultPrefs() };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, time: new Date().toISOString() }, cors);
      }
      if (url.pathname === '/subscribe' && request.method === 'POST') {
        return await handleSubscribe(request, env, cors);
      }
      if (url.pathname === '/prefs' && request.method === 'POST') {
        return await handlePrefs(request, env, cors);
      }
      if (url.pathname === '/unsubscribe' && request.method === 'POST') {
        return await handleUnsubscribe(request, env, cors);
      }
      if (url.pathname === '/admin/test-push' && request.method === 'POST') {
        return await handleTestPush(request, env, cors);
      }
      return json({ error: 'not found' }, cors, 404);
    } catch (err) {
      console.error('fetch error', err);
      return json({ error: String(err && err.message || err) }, cors, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
};

// --- HTTP handlers --------------------------------------------------------

async function handleSubscribe(request, env, cors) {
  const body = await request.json().catch(() => null);
  const sub = body && body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json({ error: 'invalid subscription' }, cors, 400);
  }
  const prefs = sanitizePrefs(body.prefs);
  const key = 'sub:' + (await hash(sub.endpoint));
  await env.STATE.put(key, JSON.stringify({ subscription: sub, prefs }));
  return json({ ok: true, prefs }, cors);
}

async function handlePrefs(request, env, cors) {
  const body = await request.json().catch(() => null);
  const endpoint = body && body.endpoint;
  if (!endpoint) return json({ error: 'missing endpoint' }, cors, 400);
  const key = 'sub:' + (await hash(endpoint));
  const raw = await env.STATE.get(key);
  const rec = parseSubscriberRecord(raw);
  if (!rec) return json({ error: 'unknown subscription' }, cors, 404);
  rec.prefs = sanitizePrefs(body.prefs);
  await env.STATE.put(key, JSON.stringify(rec));
  return json({ ok: true, prefs: rec.prefs }, cors);
}

async function handleUnsubscribe(request, env, cors) {
  const body = await request.json().catch(() => null);
  const endpoint = body && body.endpoint;
  if (!endpoint) return json({ error: 'missing endpoint' }, cors, 400);
  const key = 'sub:' + (await hash(endpoint));
  await env.STATE.delete(key);
  return json({ ok: true }, cors);
}

async function handleTestPush(request, env, cors) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${env.ADMIN_TOKEN || ''}` || !env.ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, cors, 401);
  }
  const subs = await listSubscribers(env); // test ignores prefs
  const notification = {
    type: 'test',
    title: 'Test notification',
    body: 'Web Push is wired up correctly. ⚽',
    url: '/',
  };
  const results = await Promise.allSettled(
    subs.map((s) => sendOne(env, s.name, s.subscription, notification))
  );
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length;
  return json({ sent: subs.length, ok, failed: subs.length - ok }, cors);
}

// --- Cron tick ------------------------------------------------------------

async function runTick(env) {
  // Cheap guard: outside the tournament window, do nothing.
  if (!isInWindow(env)) return;

  // Pull today (UTC) and tomorrow (UTC) — covers any live match.
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const dates = [ymd(today), ymd(tomorrow)];

  const fresh = [];
  for (const d of dates) {
    try {
      const res = await fetch(`${ESPN_BASE}?dates=${d}&limit=100`, {
        headers: { 'user-agent': 'wc2026-push/1.0' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of data.events || []) {
        const norm = normalizeEvent(ev);
        if (norm) fresh.push(norm);
      }
    } catch (e) {
      console.warn('ESPN fetch failed', d, e);
    }
  }

  if (!fresh.length) return;

  // Diff against KV, accumulate notifications.
  const notifications = [];

  // (a) Pre-game window — scheduled matches within ~30 min of kickoff.
  const now = Date.now();
  for (const ev of fresh) {
    if (ev.state !== 'pre' || !ev.date) continue;
    const ms = new Date(ev.date).getTime() - now;
    if (ms < PREGAME_MIN_MS || ms > PREGAME_MAX_MS) continue;
    const marker = 'pregame:' + ev.id;
    if (await env.STATE.get(marker)) continue;
    notifications.push({
      type: 'preGame',
      eventId: ev.id,
      title: `Starts in ~30 min: ${ev.name}`,
      body: `${ev.homeName} vs ${ev.awayName}`,
      url: '/',
    });
    // Marker expires shortly after kickoff — 1 hour is plenty.
    await env.STATE.put(marker, '1', { expirationTtl: 60 * 60 });
  }

  // (b) State-change diffs — kickoff / goal / final.
  for (const ev of fresh) {
    const prevRaw = await env.STATE.get('event:' + ev.id);
    const prev = prevRaw ? JSON.parse(prevRaw) : null;
    const diffs = diffEvent(prev, ev);
    for (const d of diffs) notifications.push(d);
    await env.STATE.put(
      'event:' + ev.id,
      JSON.stringify({
        state: ev.state,
        homeScore: ev.homeScore,
        awayScore: ev.awayScore,
        name: ev.name,
      })
    );
  }

  if (!notifications.length) return;

  console.log(`tick: ${notifications.length} notification(s):`,
    notifications.map((n) => `${n.type}:${n.eventId}`).join(', '));

  const subs = await listSubscribers(env);
  if (!subs.length) {
    console.log('tick: no subscribers, dropping');
    return;
  }

  // Fan out: each subscriber only receives notifications they opted into.
  const tasks = [];
  for (const n of notifications) {
    for (const s of subs) {
      if (!s.prefs[n.type]) continue;
      tasks.push(sendOne(env, s.name, s.subscription, n));
    }
  }
  const results = await Promise.allSettled(tasks);
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length;
  const fail = results.length - ok;
  console.log(`tick: delivered ${ok}/${results.length} (${fail} failed)`);
}

async function sendOne(env, key, subscription, notification) {
  try {
    const { method, headers, body } = await buildPushPayload(
      { data: notification, options: { ttl: 24 * 60 * 60, urgency: 'high' } },
      subscription,
      vapidKeys(env)
    );
    const res = await fetch(subscription.endpoint, { method, headers, body });
    if (res.status === 201 || res.status === 204) return 'ok';
    if (res.status === 404 || res.status === 410) {
      await env.STATE.delete(key);
      console.warn(`push gone (${res.status}) — pruned ${key}`);
      return 'fail';
    }
    const errBody = await res.text().catch(() => '');
    console.warn(`push failed ${res.status} for ${key}: ${errBody.slice(0, 200)}`);
    return 'fail';
  } catch (err) {
    console.warn(
      `push throw for ${key}:`,
      JSON.stringify({
        name: err && err.name,
        message: err && err.message,
        stack: err && err.stack && err.stack.split('\n').slice(0, 3).join(' | '),
      })
    );
    return 'fail';
  }
}

async function listSubscribers(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const raw = await env.STATE.get(k.name);
      const rec = parseSubscriberRecord(raw);
      if (!rec) continue;
      out.push({ name: k.name, subscription: rec.subscription, prefs: rec.prefs });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// --- Diff -----------------------------------------------------------------

function diffEvent(prev, curr) {
  const out = [];
  // First time we've seen this event — establish baseline, no push.
  if (!prev) return out;

  const prevState = prev.state;
  const currState = curr.state;

  if (prevState === 'pre' && currState === 'in') {
    out.push({
      type: 'kickoff',
      eventId: curr.id,
      title: `Kickoff: ${curr.name}`,
      body: `${curr.homeName} vs ${curr.awayName} just kicked off.`,
      url: '/',
    });
  } else if (prevState === 'in' && currState === 'in') {
    const prevH = Number(prev.homeScore || 0);
    const prevA = Number(prev.awayScore || 0);
    const currH = Number(curr.homeScore || 0);
    const currA = Number(curr.awayScore || 0);
    if (currH > prevH) {
      out.push(goalPush(curr, curr.homeName));
    }
    if (currA > prevA) {
      out.push(goalPush(curr, curr.awayName));
    }
  } else if (prevState === 'in' && currState === 'post') {
    out.push({
      type: 'final',
      eventId: curr.id,
      title: `FT: ${curr.homeName} ${curr.homeScore}-${curr.awayScore} ${curr.awayName}`,
      body: 'Full time.',
      url: '/',
    });
  }
  return out;
}

function goalPush(ev, scorerSide) {
  return {
    type: 'goal',
    eventId: ev.id,
    title: `GOAL! ${ev.homeName} ${ev.homeScore}-${ev.awayScore} ${ev.awayName}`,
    body: `${scorerSide} scored. ${ev.minute || ''}`.trim(),
    url: '/',
  };
}

// --- Helpers --------------------------------------------------------------

function normalizeEvent(ev) {
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  const status = (ev.status && ev.status.type) || {};
  return {
    id: ev.id,
    name: ev.name,
    date: ev.date, // ISO UTC kickoff
    state: status.state || 'pre',
    minute: status.shortDetail || '',
    homeName: home.team.displayName,
    awayName: away.team.displayName,
    homeScore: home.score,
    awayScore: away.score,
  };
}

function isInWindow(env) {
  if (!env || !env.TOURNAMENT_START || !env.TOURNAMENT_END) return true;
  const now = Date.now();
  const start = new Date(env.TOURNAMENT_START + 'T00:00:00Z').getTime();
  const end = new Date(env.TOURNAMENT_END + 'T23:59:59Z').getTime();
  return now >= start && now <= end;
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function corsHeaders(env) {
  const allow = (env && env.ALLOWED_ORIGIN) || '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function json(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function hash(s) {
  const bytes = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
