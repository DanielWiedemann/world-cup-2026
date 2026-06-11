// World Cup 2026 — fetches fixtures from ESPN's CORS-friendly scoreboard
// endpoint, caches in localStorage, renders in the user's local timezone.

const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const TOURNAMENT_START = '2026-06-11';
const TOURNAMENT_END = '2026-07-19';
const CACHE_KEY = 'wc2026.events.v1';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LIVE_POLL_MS = 30 * 1000; // 30 seconds while something's live
const KICKOFF_WINDOW_MS = 10 * 60 * 1000; // start polling 10 min before kickoff

// Web Push — points at the deployed Cloudflare Worker.
// Leave empty to hide the notifications button.
const PUSH_API = 'https://world-cup-2026-push.daniel-w.workers.dev';
const VAPID_PUBLIC_KEY =
  'BHwaEQEYH_vgR8brwqEJv05iyh3Ze-GmtaLX_NRmyqWs3aTirufT10AnbaXbaVpd0geqZ7o-cvuooHTdR4dTLEc';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
const $ = (sel) => document.querySelector(sel);
const matchesEl = $('#matches');
const statusEl = $('#status');
const updatedEl = $('#updated');
const refreshBtn = $('#refresh');
$('#tz-label').textContent = `Times shown in ${tz}`;

let state = { events: [], filter: 'upcoming', loading: false };
let pollTimer = null;

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    render();
  });
});
refreshBtn.addEventListener('click', () => load({ force: true }));

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && hasActiveMatches()) livePoll();
  updateLivePolling();
});

// --- Web Push wiring (only if PUSH_API is configured) ---------------------
const notifyBtn = $('#notify');
if (PUSH_API && 'serviceWorker' in navigator && 'PushManager' in window) {
  notifyBtn.hidden = false;
  refreshNotifyButton();
  notifyBtn.addEventListener('click', toggleNotifications);
}

async function getCurrentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshNotifyButton() {
  try {
    const sub = await getCurrentSubscription();
    const enabled = !!sub && Notification.permission === 'granted';
    notifyBtn.classList.toggle('on', enabled);
    notifyBtn.title = enabled ? 'Disable notifications' : 'Enable notifications';
    notifyBtn.setAttribute(
      'aria-label',
      enabled ? 'Disable notifications' : 'Enable notifications'
    );
  } catch {}
}

async function toggleNotifications() {
  try {
    const existing = await getCurrentSubscription();
    if (existing) {
      await fetch(`${PUSH_API}/unsubscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      }).catch(() => {});
      await existing.unsubscribe();
      setStatus('Notifications off');
    } else {
      if (Notification.permission === 'denied') {
        setStatus('Allow notifications in your browser settings.');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setStatus('Notifications not enabled.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const res = await fetch(`${PUSH_API}/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error('subscribe failed: ' + res.status);
      setStatus('Notifications on');
    }
    refreshNotifyButton();
    setTimeout(() => setStatus(''), 2500);
  } catch (err) {
    console.error(err);
    setStatus('Could not change notifications');
  }
}

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function buildDateList(startISO, endISO) {
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  const dates = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(ymd(d));
  }
  return dates;
}

async function fetchDate(dateStr) {
  const url = `${ESPN_BASE}?dates=${dateStr}&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${dateStr}`);
  const data = await res.json();
  return (data.events || []).map(normalize);
}

function normalize(ev) {
  const comp = ev.competitions && ev.competitions[0];
  const home = comp && comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp && comp.competitors.find((c) => c.homeAway === 'away');
  const status = ev.status && ev.status.type ? ev.status.type : {};
  const venue = (comp && comp.venue) || {};
  return {
    id: ev.id,
    date: ev.date, // ISO UTC
    name: ev.name,
    shortName: ev.shortName,
    state: status.state || 'pre', // pre | in | post
    detail: status.shortDetail || status.detail || '',
    completed: !!status.completed,
    home: home && {
      name: home.team.displayName,
      short: home.team.shortDisplayName || home.team.abbreviation,
      abbr: home.team.abbreviation,
      logo: home.team.logo,
      score: home.score,
    },
    away: away && {
      name: away.team.displayName,
      short: away.team.shortDisplayName || away.team.abbreviation,
      abbr: away.team.abbreviation,
      logo: away.team.logo,
      score: away.score,
    },
    venue: venue.fullName,
    city: venue.address && venue.address.city,
  };
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.events) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(events) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ events, fetchedAt: Date.now() })
    );
  } catch {}
}

function hasActiveMatches() {
  const now = Date.now();
  return state.events.some((e) => {
    if (e.state === 'in') return true;
    if (e.state === 'pre') {
      const t = new Date(e.date).getTime();
      return t - now < KICKOFF_WINDOW_MS && t - now > -KICKOFF_WINDOW_MS;
    }
    return false;
  });
}

function updateLivePolling() {
  const shouldPoll = !document.hidden && hasActiveMatches();
  if (shouldPoll && !pollTimer) {
    pollTimer = setInterval(livePoll, LIVE_POLL_MS);
    document.body.classList.add('is-live');
  } else if (!shouldPoll && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    document.body.classList.remove('is-live');
  }
}

async function livePoll() {
  const now = new Date();
  const dates = new Set();
  dates.add(ymd(now));
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  dates.add(ymd(tomorrow));
  for (const e of state.events) {
    if (e.state === 'in') dates.add(ymd(new Date(e.date)));
  }
  try {
    const results = await Promise.allSettled([...dates].map(fetchDate));
    const fresh = [];
    for (const r of results) if (r.status === 'fulfilled') fresh.push(...r.value);
    if (!fresh.length) return;
    const map = new Map(state.events.map((e) => [e.id, e]));
    for (const e of fresh) map.set(e.id, e);
    state.events = Array.from(map.values()).sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    saveCache(state.events);
    setUpdated(Date.now());
    render();
  } catch (err) {
    console.error('Live poll failed', err);
  }
}

async function load({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;

  const cached = loadCache();
  if (cached && !force && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    state.events = cached.events;
    setUpdated(cached.fetchedAt);
    render();
    state.loading = false;
    return;
  }

  if (cached) {
    state.events = cached.events;
    setUpdated(cached.fetchedAt);
    render();
  }

  setStatus('Updating…');
  refreshBtn.classList.add('spin');

  try {
    const dates = buildDateList(TOURNAMENT_START, TOURNAMENT_END);
    const chunkSize = 6;
    const all = [];
    for (let i = 0; i < dates.length; i += chunkSize) {
      const slice = dates.slice(i, i + chunkSize);
      const results = await Promise.allSettled(slice.map(fetchDate));
      for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
    }
    const dedup = Array.from(new Map(all.map((e) => [e.id, e])).values());
    dedup.sort((a, b) => new Date(a.date) - new Date(b.date));
    state.events = dedup;
    saveCache(dedup);
    setUpdated(Date.now());
    setStatus('');
    render();
  } catch (err) {
    console.error(err);
    setStatus('Offline — showing cached data');
  } finally {
    refreshBtn.classList.remove('spin');
    state.loading = false;
  }
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setUpdated(ts) {
  if (!ts) {
    updatedEl.textContent = '';
    return;
  }
  const d = new Date(ts);
  updatedEl.textContent = `Updated ${d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function localDayKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayLabel(iso) {
  const d = new Date(iso + 'T12:00:00');
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function filterEvents(events) {
  const now = Date.now();
  const today = localDayKey(new Date().toISOString());
  if (state.filter === 'today') {
    return events.filter((e) => localDayKey(e.date) === today);
  }
  if (state.filter === 'upcoming') {
    return events.filter((e) => e.state !== 'post' && new Date(e.date).getTime() > now - 3 * 60 * 60 * 1000);
  }
  return events;
}

function groupByDay(events) {
  const map = new Map();
  for (const e of events) {
    const key = localDayKey(e.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function teamMarkup(t) {
  if (!t) return '<div class="team"></div>';
  const logo = t.logo
    ? `<img class="logo" src="${escapeHtml(t.logo)}" alt="" loading="lazy" />`
    : `<div class="logo placeholder">${escapeHtml((t.abbr || '?').slice(0, 3))}</div>`;
  return `<div class="team">${logo}<span class="team-name">${escapeHtml(t.short || t.name || '')}</span></div>`;
}

function matchCard(e) {
  const live = e.state === 'in';
  const done = e.state === 'post';
  const upcoming = e.state === 'pre';
  const score =
    !upcoming && e.home && e.away
      ? `<div class="score"><span>${escapeHtml(e.home.score)}</span><span class="dash">–</span><span>${escapeHtml(e.away.score)}</span></div>`
      : `<div class="kickoff">${formatTime(e.date)}</div>`;
  const badge = live
    ? `<span class="badge live">● Live · ${escapeHtml(e.detail)}</span>`
    : done
    ? `<span class="badge done">Final</span>`
    : '';
  const venue = e.venue
    ? `<div class="venue">${escapeHtml(e.venue)}${e.city ? ', ' + escapeHtml(e.city) : ''}</div>`
    : '';
  return `
    <article class="match ${e.state}">
      <div class="match-top">
        ${teamMarkup(e.home)}
        ${score}
        ${teamMarkup(e.away)}
      </div>
      <div class="match-bottom">
        ${badge}
        ${venue}
      </div>
    </article>
  `;
}

function render() {
  const filtered = filterEvents(state.events);
  if (!filtered.length) {
    matchesEl.innerHTML = state.events.length
      ? `<p class="empty">No matches match this filter.</p>`
      : `<p class="empty">Loading fixtures…</p>`;
    updateLivePolling();
    return;
  }
  const liveEvents = filtered.filter((e) => e.state === 'in');
  const otherEvents = filtered.filter((e) => e.state !== 'in');
  const liveSection = liveEvents.length
    ? `<section class="day live-now">
         <h2 class="day-header live-header">
           <span class="pulse-dot" aria-hidden="true"></span>Live now
         </h2>
         ${liveEvents.map(matchCard).join('')}
       </section>`
    : '';
  const groups = groupByDay(otherEvents);
  matchesEl.innerHTML =
    liveSection +
    groups
      .map(
        ([day, evs]) => `
      <section class="day">
        <h2 class="day-header">${escapeHtml(formatDayLabel(day))}</h2>
        ${evs.map(matchCard).join('')}
      </section>
    `
      )
      .join('');
  updateLivePolling();
}

load();
