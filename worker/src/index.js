// World Cup 2026 push notification Worker.
//
// HTTP endpoints (CORS-enabled for ALLOWED_ORIGIN):
//   POST /subscribe   { subscription: PushSubscription }
//   POST /unsubscribe { endpoint }
//   GET  /health
//
// Cron handler (every minute):
//   - Poll ESPN scoreboard for the active tournament window.
//   - Diff each event against KV state.
//   - Fan out push for kickoff / goal / final whistle.

import webpush from 'web-push';

const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

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
      if (url.pathname === '/unsubscribe' && request.method === 'POST') {
        return await handleUnsubscribe(request, env, cors);
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
  if (!isInWindow()) {
    // Still accept; tournament window guard is for cron only.
  }
  const key = 'sub:' + (await hash(sub.endpoint));
  await env.STATE.put(key, JSON.stringify(sub));
  return json({ ok: true }, cors);
}

async function handleUnsubscribe(request, env, cors) {
  const body = await request.json().catch(() => null);
  const endpoint = body && body.endpoint;
  if (!endpoint) return json({ error: 'missing endpoint' }, cors, 400);
  const key = 'sub:' + (await hash(endpoint));
  await env.STATE.delete(key);
  return json({ ok: true }, cors);
}

// --- Cron tick ------------------------------------------------------------

async function runTick(env) {
  // Cheap guard: outside the tournament window, do nothing.
  if (!isInWindow(env)) return;

  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

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

  // Load all subscriptions.
  const subs = await listSubscriptions(env);
  if (!subs.length) return;

  // Fan out: one push per (notification × subscription).
  const tasks = [];
  for (const n of notifications) {
    const payload = JSON.stringify(n);
    for (const sub of subs) tasks.push(sendOne(env, sub, payload));
  }
  await Promise.allSettled(tasks);
}

async function sendOne(env, sub, payload) {
  try {
    await webpush.sendNotification(sub.value, payload);
  } catch (err) {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      // Subscription is dead — clean it up.
      await env.STATE.delete(sub.name);
    } else {
      console.warn('push failed', err && err.statusCode, err && err.body);
    }
  }
}

async function listSubscriptions(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const raw = await env.STATE.get(k.name);
      if (!raw) continue;
      try {
        out.push({ name: k.name, value: JSON.parse(raw) });
      } catch {}
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
