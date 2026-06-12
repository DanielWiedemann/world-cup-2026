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
const nextBannerEl = $('#next-banner');
$('#tz-label').textContent = `Times shown in ${tz}`;

const STATS_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary';
const STATS_CACHE_KEY = 'wc2026.stats.v1';
const STATS_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours; live matches force refresh

// Map ESPN team abbreviations to the Guardian team names that key photos.json.
const ABBR_TO_GUARDIAN = {
  ALG: 'Algeria', ARG: 'Argentina', AUS: 'Australia', AUT: 'Austria',
  BEL: 'Belgium', BIH: 'Bosnia and Herzegovina', BRA: 'Brazil', CAN: 'Canada',
  CPV: 'Cape Verde', COL: 'Colombia', COD: 'DR Congo', CRO: 'Croatia',
  CUW: 'Curaçao', CZE: 'Czechia', ECU: 'Ecuador', EGY: 'Egypt',
  ENG: 'England', FRA: 'France', GER: 'Germany', GHA: 'Ghana',
  HAI: 'Haiti', IRN: 'Iran', IRQ: 'Iraq', CIV: "Côte d'Ivoire",
  JPN: 'Japan', JOR: 'Jordan', MEX: 'Mexico', MAR: 'Morocco',
  NED: 'Netherlands', NZL: 'New Zealand', NOR: 'Norway', PAN: 'Panama',
  PAR: 'Paraguay', POR: 'Portugal', QAT: 'Qatar', KSA: 'Saudi Arabia',
  SCO: 'Scotland', SEN: 'Senegal', RSA: 'South Africa', KOR: 'South Korea',
  ESP: 'Spain', SWE: 'Sweden', SUI: 'Switzerland', TUN: 'Tunisia',
  TUR: 'Turkey', USA: 'USA', URU: 'Uruguay', UZB: 'Uzbekistan',
};
let photoDb = null;
let photoDbPromise = null;
async function ensurePhotoDb() {
  if (photoDb) return photoDb;
  if (!photoDbPromise) {
    photoDbPromise = fetch('photos.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((db) => (photoDb = db || {}))
      .catch(() => (photoDb = {}));
  }
  return photoDbPromise;
}
function photoFor(teamAbbr, jersey) {
  if (!photoDb || !teamAbbr || !jersey) return '';
  const guardianTeam = ABBR_TO_GUARDIAN[teamAbbr];
  if (!guardianTeam) return '';
  return photoDb[guardianTeam]?.[String(jersey)]?.photo || '';
}

let state = {
  events: [],
  filter: 'upcoming',
  loading: false,
  expanded: new Set(),
  stats: loadStatsCache(),
};
let pollTimer = null;
let nextBannerTimer = null;

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
  updateNextBanner();
});

matchesEl.addEventListener('click', (e) => {
  // Player badge → open overlay (timeline or pitch).
  const badge = e.target.closest('.tl-badge.photo, .pp-badge.photo');
  if (badge && badge.dataset.playerPhoto) {
    e.stopPropagation();
    openPlayerDialog(badge.dataset);
    return;
  }
  // Lineups sub-section toggle (independent expand state per event).
  const lineupBtn = e.target.closest('.lineups-toggle');
  if (lineupBtn) {
    e.stopPropagation();
    const key = lineupBtn.dataset.toggle;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    render();
    return;
  }
  const card = e.target.closest('.match');
  if (!card) return;
  if (card.classList.contains('pre')) return; // No stats for upcoming.
  const id = card.dataset.eventId;
  if (!id) return;
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
  if (state.expanded.has(id)) ensureStats(id);
});

const POSITION_LONG = {
  G: 'Goalkeeper', GK: 'Goalkeeper',
  D: 'Defender', CD: 'Centre back', CB: 'Centre back',
  'CD-L': 'Left centre back', 'CD-R': 'Right centre back',
  LB: 'Left back', RB: 'Right back', LWB: 'Left wing back', RWB: 'Right wing back',
  M: 'Midfielder', CM: 'Central midfielder', DM: 'Defensive midfielder',
  AM: 'Attacking midfielder', LM: 'Left midfielder', RM: 'Right midfielder',
  F: 'Forward', ST: 'Striker', CF: 'Centre forward',
  LW: 'Left wing', RW: 'Right wing', LF: 'Left forward', RF: 'Right forward',
};

const playerDialog = $('#player-dialog');
const playerDialogPhoto = $('#player-dialog-photo');
const playerDialogName = $('#player-dialog-name');
const playerDialogMeta = $('#player-dialog-meta');
const playerDialogClose = $('#player-dialog-close');

function openPlayerDialog(data) {
  if (!playerDialog) return;
  playerDialogPhoto.src = data.playerPhoto;
  playerDialogPhoto.alt = data.playerName || '';
  playerDialogName.textContent = data.playerName || '';
  const team = data.playerTeam || '';
  const pos = POSITION_LONG[data.playerPos] || data.playerPos || '';
  const jersey = data.playerJersey ? `#${data.playerJersey}` : '';
  playerDialogMeta.textContent = [team, pos, jersey].filter(Boolean).join(' · ');
  if (typeof playerDialog.showModal === 'function') playerDialog.showModal();
}

playerDialogClose?.addEventListener('click', () => playerDialog.close());
playerDialog?.addEventListener('click', (e) => {
  // Click outside the dialog content closes it.
  const rect = playerDialog.getBoundingClientRect();
  const insideDialog =
    e.clientX >= rect.left && e.clientX <= rect.right &&
    e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!insideDialog) playerDialog.close();
});
// Keyboard accessibility — Enter/Space on a focused badge opens the dialog.
matchesEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const badge = e.target.closest('.tl-badge.photo, .pp-badge.photo');
  if (badge && badge.dataset.playerPhoto) {
    e.preventDefault();
    openPlayerDialog(badge.dataset);
  }
});

// 1-sec tick keeps the seconds counter live when kickoff is under an hour;
// the banner itself is hidden when nothing's within 48h, so the work is cheap.
nextBannerTimer = setInterval(updateNextBanner, 1000);

// --- Web Push wiring (only if PUSH_API is configured) ---------------------
const PREF_KEYS = ['preGame', 'kickoff', 'goal', 'final'];
const PREFS_STORAGE_KEY = 'wc2026.notif.prefs.v2';
let selectedTeams = new Set();
const notifyBtn = $('#notify');
const prefsDialog = $('#prefs-dialog');
const prefsForm = $('#prefs-form');
const prefsStatus = $('#prefs-status');
const prefsSub = $('#prefs-sub');
const prefsSaveBtn = $('#prefs-save');
const prefsCancelBtn = $('#prefs-cancel');
const prefsDisableBtn = $('#prefs-disable');

function defaultPrefs() {
  return {
    preGame: true,
    kickoff: true,
    goal: true,
    final: true,
    teamFilter: false,
    teams: [],
  };
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const p = JSON.parse(raw);
    return { ...defaultPrefs(), ...p };
  } catch {
    return defaultPrefs();
  }
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs)); } catch {}
}

function readPrefsFromForm() {
  const out = {};
  for (const k of PREF_KEYS) {
    const input = prefsForm.querySelector(`input[data-key="${k}"]`);
    out[k] = !!(input && input.checked);
  }
  const tfInput = prefsForm.querySelector(`input[data-key="teamFilter"]`);
  out.teamFilter = !!(tfInput && tfInput.checked);
  out.teams = Array.from(selectedTeams);
  return out;
}

function writePrefsToForm(prefs) {
  for (const k of PREF_KEYS) {
    const input = prefsForm.querySelector(`input[data-key="${k}"]`);
    if (input) input.checked = !!prefs[k];
  }
  const tfInput = prefsForm.querySelector(`input[data-key="teamFilter"]`);
  if (tfInput) tfInput.checked = !!prefs.teamFilter;
  selectedTeams = new Set(Array.isArray(prefs.teams) ? prefs.teams : []);
  renderTeamsPicker();
}

function getAllTeams() {
  const seen = new Map();
  for (const e of state.events) {
    for (const t of [e.home, e.away]) {
      if (!t || !t.abbr) continue;
      // Real national teams have 2–4 pure-letter abbreviations (USA, BRA, KSA,
      // BIH…). Placeholders like "1A", "QFW1", "RD16 W1", "3RD" contain digits
      // or spaces — strip them out.
      if (!/^[A-Z]{2,4}$/.test(t.abbr)) continue;
      if (seen.has(t.abbr)) continue;
      seen.set(t.abbr, { abbr: t.abbr, name: t.name || t.short || t.abbr, logo: t.logo });
    }
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

function renderTeamsPicker() {
  const picker = document.getElementById('teams-picker');
  const grid = document.getElementById('teams-grid');
  const tfInput = prefsForm.querySelector(`input[data-key="teamFilter"]`);
  const enabled = !!(tfInput && tfInput.checked);
  picker.hidden = !enabled;
  if (!enabled) return;
  const teams = getAllTeams();
  grid.innerHTML = teams
    .map((t) => {
      const isSel = selectedTeams.has(t.abbr);
      const logo = t.logo
        ? `<img src="${escapeHtml(t.logo)}" alt="" loading="lazy" />`
        : '';
      return `<label class="team-chip${isSel ? ' selected' : ''}" data-abbr="${escapeHtml(t.abbr)}">
        <input type="checkbox" ${isSel ? 'checked' : ''} />
        ${logo}
        <span class="team-chip-name">${escapeHtml(t.name)}</span>
      </label>`;
    })
    .join('');
  updateTeamsCount();
}

function updateTeamsCount() {
  const el = document.getElementById('teams-count');
  if (!el) return;
  const total = getAllTeams().length;
  el.textContent = `${selectedTeams.size} of ${total} selected`;
}

function setPrefsStatus(msg, isError = false) {
  prefsStatus.textContent = msg || '';
  prefsStatus.classList.toggle('error', !!isError);
}

if (PUSH_API && 'serviceWorker' in navigator && 'PushManager' in window) {
  notifyBtn.hidden = false;
  refreshNotifyButton();
  notifyBtn.addEventListener('click', openPrefsDialog);
  prefsCancelBtn.addEventListener('click', () => prefsDialog.close());
  prefsDisableBtn.addEventListener('click', disableNotifications);
  prefsForm.addEventListener('submit', onPrefsSubmit);
  prefsDialog.addEventListener('click', (e) => {
    // Click on backdrop = outside the form rect = close.
    const rect = prefsForm.getBoundingClientRect();
    const inForm =
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inForm) prefsDialog.close();
  });

  // Toggle the team picker when the team-filter switch flips.
  prefsForm.addEventListener('change', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.key === 'teamFilter') {
      renderTeamsPicker();
    }
  });

  // Team chip clicks + All / None shortcuts.
  prefsForm.addEventListener('click', (e) => {
    const chip = e.target.closest('.team-chip');
    if (chip) {
      const abbr = chip.dataset.abbr;
      if (selectedTeams.has(abbr)) selectedTeams.delete(abbr);
      else selectedTeams.add(abbr);
      chip.classList.toggle('selected');
      const input = chip.querySelector('input[type="checkbox"]');
      if (input) input.checked = selectedTeams.has(abbr);
      updateTeamsCount();
      return;
    }
    const action = e.target.closest('[data-team-action]');
    if (action) {
      e.preventDefault();
      const kind = action.dataset.teamAction;
      if (kind === 'all') selectedTeams = new Set(getAllTeams().map((t) => t.abbr));
      if (kind === 'none') selectedTeams = new Set();
      renderTeamsPicker();
    }
  });
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
    notifyBtn.title = enabled ? 'Notification settings' : 'Enable notifications';
    notifyBtn.setAttribute(
      'aria-label',
      enabled ? 'Notification settings' : 'Enable notifications'
    );
  } catch {}
}

async function openPrefsDialog() {
  const existing = await getCurrentSubscription();
  const subscribed = !!existing && Notification.permission === 'granted';
  writePrefsToForm(loadPrefs());
  setPrefsStatus('');
  prefsSaveBtn.textContent = subscribed ? 'Save' : 'Enable';
  prefsSub.textContent = subscribed
    ? 'Adjust which moments push to your phone.'
    : 'Pick the moments you want to hear about.';
  prefsDisableBtn.hidden = !subscribed;
  if (typeof prefsDialog.showModal === 'function') prefsDialog.showModal();
  else prefsDialog.setAttribute('open', '');
}

async function onPrefsSubmit(e) {
  e.preventDefault();
  const prefs = readPrefsFromForm();
  prefsSaveBtn.disabled = true;
  setPrefsStatus('Saving…');
  try {
    const existing = await getCurrentSubscription();
    if (existing && Notification.permission === 'granted') {
      const res = await fetch(`${PUSH_API}/prefs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint, prefs }),
      });
      if (!res.ok) throw new Error('prefs update failed: ' + res.status);
    } else {
      if (Notification.permission === 'denied') {
        setPrefsStatus('Notifications are blocked in your browser settings.', true);
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setPrefsStatus('Notifications not enabled.', true);
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
        body: JSON.stringify({ subscription: sub.toJSON(), prefs }),
      });
      if (!res.ok) throw new Error('subscribe failed: ' + res.status);
    }
    savePrefs(prefs);
    refreshNotifyButton();
    setStatus('Notifications saved');
    setTimeout(() => setStatus(''), 2000);
    prefsDialog.close();
  } catch (err) {
    console.error(err);
    setPrefsStatus('Could not save. Please try again.', true);
  } finally {
    prefsSaveBtn.disabled = false;
  }
}

async function disableNotifications() {
  prefsDisableBtn.disabled = true;
  setPrefsStatus('Disabling…');
  try {
    const existing = await getCurrentSubscription();
    if (existing) {
      await fetch(`${PUSH_API}/unsubscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      }).catch(() => {});
      await existing.unsubscribe();
    }
    refreshNotifyButton();
    setStatus('Notifications off');
    setTimeout(() => setStatus(''), 2000);
    prefsDialog.close();
  } catch (err) {
    console.error(err);
    setPrefsStatus('Could not turn off notifications.', true);
  } finally {
    prefsDisableBtn.disabled = false;
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
  if (state.filter === 'past') {
    // Most-recent first.
    return events
      .filter((e) => e.state === 'post')
      .slice()
      .sort((a, b) => new Date(b.date) - new Date(a.date));
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
  const entries = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return state.filter === 'past' ? entries.reverse() : entries;
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
  const expandable = !upcoming;
  const isExpanded = state.expanded.has(e.id);
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
  const statsBlock = expandable && isExpanded ? renderStats(e) : '';
  const hint = expandable
    ? `<span class="expand-hint" aria-hidden="true">${isExpanded ? '▴' : '▾'}</span>`
    : '';
  return `
    <article class="match ${e.state}${isExpanded ? ' expanded' : ''}${expandable ? ' expandable' : ''}" data-event-id="${escapeHtml(e.id)}">
      <div class="match-top">
        ${teamMarkup(e.home)}
        ${score}
        ${teamMarkup(e.away)}
      </div>
      <div class="match-bottom">
        ${badge}
        ${venue}
        ${hint}
      </div>
      ${statsBlock}
    </article>
  `;
}

function renderStats(e) {
  const entry = state.stats[e.id];
  if (!entry) {
    return `<div class="stats loading">Loading stats…</div>`;
  }
  if (entry.error) {
    return `<div class="stats empty">${escapeHtml(entry.error)}</div>`;
  }
  const hasRows = entry.rows && entry.rows.length;
  const hasTimeline = entry.timeline && entry.timeline.length;
  const hasLineups = entry.lineups && entry.lineups.home;
  if (!hasRows && !hasTimeline && !hasLineups) {
    return `<div class="stats empty">No stats available yet.</div>`;
  }
  return `
    <div class="stats">
      ${hasTimeline ? renderTimeline(e, entry.timeline, entry.lineups) : ''}
      ${hasRows ? renderStatsTable(e, entry.rows) : ''}
      ${hasLineups ? renderLineups(e, entry.lineups) : ''}
    </div>
  `;
}

const TIMELINE_GLYPH = {
  'goal': '⚽',
  'own-goal': '⚽',
  'penalty-goal': '⚽',
  'yellow-card': '<span class="card yellow"></span>',
  'red-card': '<span class="card red"></span>',
};

function timelineSide(entry, e) {
  // Match by displayName first; fall back to abbreviation if names mismatch
  // across data sources.
  const home = e.home?.name;
  const away = e.away?.name;
  if (entry.teamName === home) return 'home';
  if (entry.teamName === away) return 'away';
  // Loose fallback: substring contains.
  if (home && entry.teamName && home.includes(entry.teamName)) return 'home';
  if (away && entry.teamName && away.includes(entry.teamName)) return 'away';
  return 'home';
}

function findRosterPlayer(lineups, side, athleteId, name) {
  const team = lineups?.[side];
  if (!team) return null;
  const all = [...(team.starters || []), ...(team.bench || [])];
  if (athleteId) {
    const byId = all.find((p) => String(p.id) === String(athleteId));
    if (byId) return byId;
  }
  if (name) {
    const byName = all.find(
      (p) => p.fullName === name || p.name === name
    );
    if (byName) return byName;
  }
  return null;
}

function playerBadge(rosterPlayer, abbr, displayName) {
  // Photo from Guardian (by team abbr + jersey), or ESPN headshot, or jersey
  // number in a circle. The data-* attributes feed the player overlay.
  const jersey = rosterPlayer?.jersey || '';
  const photo = photoFor(abbr, jersey) || rosterPlayer?.headshot || '';
  const name = displayName || rosterPlayer?.fullName || rosterPlayer?.name || '';
  const pos = rosterPlayer?.pos || '';
  const teamName = ABBR_TO_GUARDIAN[abbr] || abbr || '';
  const dataAttrs = photo
    ? `data-player-photo="${escapeHtml(photo)}" data-player-name="${escapeHtml(name)}" data-player-team="${escapeHtml(teamName)}" data-player-pos="${escapeHtml(pos)}" data-player-jersey="${escapeHtml(jersey)}" data-player-abbr="${escapeHtml(abbr || '')}" role="button" tabindex="0"`
    : '';
  if (photo) {
    return `<span class="tl-badge photo" ${dataAttrs}><img src="${escapeHtml(photo)}" alt="" loading="lazy" /></span>`;
  }
  if (jersey) {
    return `<span class="tl-badge num">${escapeHtml(jersey)}</span>`;
  }
  return `<span class="tl-badge num">?</span>`;
}

function renderTimeline(e, timeline, lineups) {
  if (!timeline.length) return '';
  const homeAbbr = e.home?.abbr;
  const awayAbbr = e.away?.abbr;
  // Single chronologically-ordered list; each row alternates side based on
  // which team the event belongs to.
  const items = timeline.map((t) => {
    const side = timelineSide(t, e);
    const abbr = side === 'home' ? homeAbbr : awayAbbr;
    const rosterPlayer = findRosterPlayer(lineups, side, t.athleteId, t.player);
    const badge = playerBadge(rosterPlayer, abbr, t.player);
    const glyph = TIMELINE_GLYPH[t.kind] || '';
    const annot = t.kind === 'own-goal' ? ' (OG)' : t.kind === 'penalty-goal' ? ' (P)' : '';
    const assistHtml = t.assist
      ? `<span class="tl-assist">assist ${escapeHtml(t.assist)}</span>`
      : '';
    const minute = escapeHtml(t.minute || "—'");
    if (side === 'home') {
      return `
        <li class="tl-row home">
          <div class="tl-half">
            ${badge}
            <div class="tl-text">
              <div class="tl-name">${escapeHtml(t.player)}${escapeHtml(annot)} <span class="tl-glyph">${glyph}</span></div>
              ${assistHtml}
            </div>
            <span class="tl-dots" aria-hidden="true"></span>
            <span class="tl-minute">${minute}</span>
          </div>
        </li>`;
    }
    return `
      <li class="tl-row away">
        <div class="tl-half">
          <span class="tl-minute">${minute}</span>
          <span class="tl-dots" aria-hidden="true"></span>
          <div class="tl-text">
            <div class="tl-name"><span class="tl-glyph">${glyph}</span> ${escapeHtml(t.player)}${escapeHtml(annot)}</div>
            ${assistHtml}
          </div>
          ${badge}
        </div>
      </li>`;
  });
  return `
    <div class="stats-section">
      <h3 class="stats-section-title">Timeline</h3>
      <ol class="timeline">${items.join('')}</ol>
    </div>
  `;
}

function renderStatsTable(e, rows) {
  const homeName = e.home?.short || e.home?.name || 'Home';
  const awayName = e.away?.short || e.away?.name || 'Away';
  const rowsHtml = rows
    .map(
      (row) => `
      <tr>
        <td class="stat-val home">${escapeHtml(row.home)}</td>
        <td class="stat-label">${escapeHtml(row.label)}</td>
        <td class="stat-val away">${escapeHtml(row.away)}</td>
      </tr>`
    )
    .join('');
  return `
    <div class="stats-section">
      <h3 class="stats-section-title">Statistics</h3>
      <table class="stats-table">
        <thead><tr><th>${escapeHtml(homeName)}</th><th></th><th>${escapeHtml(awayName)}</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderLineups(e, lineups) {
  const lineupsKey = `lineups:${e.id}`;
  const open = state.expanded.has(lineupsKey);
  return `
    <div class="stats-section lineups-section">
      <button type="button" class="lineups-toggle" data-toggle="${escapeHtml(lineupsKey)}" aria-expanded="${open ? 'true' : 'false'}">
        <span>Lineups</span>
        <span class="lineups-formation">${escapeHtml(lineups.home.formation || '')} · ${escapeHtml(lineups.away.formation || '')}</span>
        <span class="lineups-chevron">${open ? '▴' : '▾'}</span>
      </button>
      ${open ? `<div class="lineups-grid">
        ${renderTeamLineup(lineups.home, e.home)}
        ${renderTeamLineup(lineups.away, e.away)}
      </div>` : ''}
    </div>
  `;
}

function arrangePitchRows(starters, formation) {
  // Bucket starters by position group from their ESPN position abbr.
  const groups = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of starters) {
    const pos = (p.pos || '').toUpperCase();
    if (pos === 'G' || pos === 'GK') groups.GK.push(p);
    else if (/^(D|CB|CD|RB|LB|RWB|LWB)/.test(pos)) groups.DEF.push(p);
    else if (/^(F|ST|CF|RF|LF|RW|LW)/.test(pos)) groups.FWD.push(p);
    else groups.MID.push(p);
  }
  // Sort each row by directional cue: L (left) → C (center) → R (right).
  const dirRank = (p) => {
    const pos = (p.pos || '').toUpperCase();
    if (/-L$|L$|LB|LW|LM/.test(pos)) return 0;
    if (/-R$|R$|RB|RW|RM/.test(pos)) return 2;
    return 1;
  };
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => dirRank(a) - dirRank(b));
  }
  // Build rows back-to-front: GK → DEF → MID → FWD.
  // If the formation suggests 4 outfield rows (e.g. "4-1-4-1"), split the MID
  // pool into two rows by its declared sizes.
  const digits = (formation || '').split('-').map((n) => parseInt(n, 10)).filter(Number.isFinite);
  let midRows = [groups.MID];
  if (digits.length === 4 && groups.MID.length === digits[1] + digits[2]) {
    midRows = [groups.MID.slice(0, digits[1]), groups.MID.slice(digits[1])];
  }
  const rows = [groups.GK, groups.DEF, ...midRows, groups.FWD].filter((r) => r.length);
  return rows;
}

function renderTeamLineup(team, eventTeam) {
  const teamLogo = eventTeam?.logo
    ? `<img class="lineup-team-logo" src="${escapeHtml(eventTeam.logo)}" alt="" loading="lazy" />`
    : '';
  const abbr = eventTeam?.abbr || team.teamAbbr;
  const rows = arrangePitchRows(team.starters, team.formation);
  const rowsHtml = rows
    .map(
      (rowPlayers) => `
      <div class="pitch-row" style="--n:${rowPlayers.length}">
        ${rowPlayers.map((p) => renderPitchPlayer(p, abbr)).join('')}
      </div>`
    )
    .join('');
  return `
    <div class="lineup-team">
      <div class="lineup-team-header">
        ${teamLogo}
        <span class="lineup-team-name">${escapeHtml(team.teamName || '')}</span>
        ${team.formation ? `<span class="lineup-formation">${escapeHtml(team.formation)}</span>` : ''}
      </div>
      <div class="pitch">
        <div class="pitch-lines" aria-hidden="true"></div>
        ${rowsHtml}
      </div>
    </div>
  `;
}

function renderPitchPlayer(p, abbr) {
  const photo = photoFor(abbr, p.jersey) || p.headshot || '';
  const teamName = ABBR_TO_GUARDIAN[abbr] || abbr || '';
  const dataAttrs = photo
    ? `data-player-photo="${escapeHtml(photo)}" data-player-name="${escapeHtml(p.fullName || p.name)}" data-player-team="${escapeHtml(teamName)}" data-player-pos="${escapeHtml(p.pos || '')}" data-player-jersey="${escapeHtml(p.jersey || '')}" data-player-abbr="${escapeHtml(abbr || '')}" role="button" tabindex="0"`
    : '';
  const badge = photo
    ? `<span class="pp-badge photo" ${dataAttrs}><img src="${escapeHtml(photo)}" alt="" loading="lazy" /></span>`
    : `<span class="pp-badge num">${escapeHtml(p.jersey || initialsOf(p.name))}</span>`;
  return `
    <div class="pitch-player">
      ${badge}
      <span class="pp-name">${escapeHtml(p.name)}</span>
    </div>
  `;
}

function initialsOf(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() || '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const STATS_LABELS = {
  possessionPct: 'Possession',
  totalShots: 'Shots',
  shotsOnTarget: 'Shots on target',
  wonCorners: 'Corners',
  foulsCommitted: 'Fouls',
  yellowCards: 'Yellow cards',
  redCards: 'Red cards',
  saves: 'Saves',
  offsides: 'Offsides',
};
const STATS_ORDER = Object.keys(STATS_LABELS);

function loadStatsCache() {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStatsCache() {
  try {
    localStorage.setItem(STATS_CACHE_KEY, JSON.stringify(state.stats));
  } catch {}
}

async function ensureStats(eventId) {
  const ev = state.events.find((e) => e.id === eventId);
  const cached = state.stats[eventId];
  const isLive = ev && ev.state === 'in';
  const isFresh =
    cached &&
    cached.fetchedAt &&
    Date.now() - cached.fetchedAt < (isLive ? 30 * 1000 : STATS_CACHE_TTL_MS);
  if (cached && isFresh && !cached.error) return;
  if (cached && cached.loading) return;
  state.stats[eventId] = { ...(cached || {}), loading: true };
  try {
    const res = await fetch(`${STATS_BASE}?event=${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error('ESPN ' + res.status);
    const data = await res.json();
    const rows = extractStatRows(data);
    const timeline = extractTimeline(data);
    const lineups = extractLineups(data);
    state.stats[eventId] = { rows, timeline, lineups, fetchedAt: Date.now() };
    saveStatsCache();
    if (state.expanded.has(eventId)) render();
  } catch (err) {
    state.stats[eventId] = {
      error: 'Could not load stats.',
      fetchedAt: Date.now(),
    };
    if (state.expanded.has(eventId)) render();
  }
}

function extractStatRows(data) {
  const teams = data && data.boxscore && data.boxscore.teams;
  if (!Array.isArray(teams) || teams.length < 2) return [];
  const home = teams.find((t) => t.homeAway === 'home') || teams[0];
  const away = teams.find((t) => t.homeAway === 'away') || teams[1];
  const homeStats = mapStats(home.statistics || []);
  const awayStats = mapStats(away.statistics || []);
  const rows = [];
  for (const key of STATS_ORDER) {
    const h = homeStats[key];
    const a = awayStats[key];
    if (h == null && a == null) continue;
    rows.push({ label: STATS_LABELS[key], home: h ?? '–', away: a ?? '–' });
  }
  return rows;
}

// Build a unified match timeline from ESPN's keyEvents: goals, cards.
// Returns [{ kind, minute, clockValue, teamName, athleteId, player, assistId, assist }]
function extractTimeline(data) {
  const ke = data?.keyEvents || [];
  const entries = [];
  for (const p of ke) {
    const t = p?.type?.type || '';
    const text = p?.type?.text || '';
    let kind = null;
    if (t === 'goal' || /^goal/i.test(text)) {
      kind = /own goal/i.test(text)
        ? 'own-goal'
        : /penalty/i.test(text) && !/saved|missed/i.test(text)
        ? 'penalty-goal'
        : 'goal';
    } else if (t === 'yellow-card' || /yellow card/i.test(text)) {
      kind = 'yellow-card';
    } else if (t === 'red-card' || /red card/i.test(text)) {
      kind = 'red-card';
    }
    if (!kind) continue;
    const players = p.participants || [];
    const player = players[0]?.athlete;
    const assist = players[1]?.athlete;
    entries.push({
      kind,
      minute: p.clock?.displayValue || '',
      clockValue: typeof p.clock?.value === 'number' ? p.clock.value : 0,
      teamName: p.team?.displayName || '',
      athleteId: player?.id,
      player: player?.shortName || player?.displayName || '?',
      assistId: assist?.id,
      assist: assist ? (assist.shortName || assist.displayName) : undefined,
    });
  }
  entries.sort((a, b) => a.clockValue - b.clockValue);
  return entries;
}

function extractLineups(data) {
  const rosters = data?.rosters || [];
  if (rosters.length < 2) return null;
  const teamLineup = (r) => {
    const all = r?.roster || [];
    const starters = all.filter((p) => p.starter).map(playerLite);
    const bench = all.filter((p) => !p.starter).map(playerLite);
    return {
      teamAbbr: r?.team?.abbreviation,
      teamName: r?.team?.displayName,
      formation: r?.formation || '',
      starters,
      bench,
    };
  };
  const home = rosters.find((r) => r.homeAway === 'home') || rosters[0];
  const away = rosters.find((r) => r.homeAway === 'away') || rosters[1];
  return { home: teamLineup(home), away: teamLineup(away) };
}

function playerLite(p) {
  const a = p.athlete || {};
  return {
    id: a.id,
    name: a.shortName || a.displayName || '?',
    fullName: a.displayName || a.shortName || '?',
    jersey: p.jersey || '',
    pos: p.position?.abbreviation || '',
    headshot: a.headshot?.href || '',
  };
}

function mapStats(arr) {
  const out = {};
  for (const s of arr) {
    if (!s || !s.name) continue;
    out[s.name] = s.displayValue != null ? s.displayValue : s.value;
  }
  return out;
}

function updateNextBanner() {
  if (!nextBannerEl) return;
  const now = Date.now();
  const next = state.events.find(
    (e) => e.state === 'pre' && new Date(e.date).getTime() > now
  );
  if (!next) {
    nextBannerEl.hidden = true;
    return;
  }
  const ms = new Date(next.date).getTime() - now;
  if (ms > 48 * 60 * 60 * 1000) {
    nextBannerEl.hidden = true;
    return;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const kickoff = new Date(next.date);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isToday = sameLocalDay(kickoff, today);
  const isTomorrow = sameLocalDay(kickoff, tomorrow);
  const when = isToday
    ? `Tonight · ${formatTime(next.date)}`
    : isTomorrow
    ? `Tomorrow · ${formatTime(next.date)}`
    : `${kickoff.toLocaleDateString([], { weekday: 'short' })} · ${formatTime(next.date)}`;
  const homeName = next.home?.short || next.home?.name || 'TBD';
  const awayName = next.away?.short || next.away?.name || 'TBD';
  const homeLogo = next.home?.logo
    ? `<img class="next-flag" src="${escapeHtml(next.home.logo)}" alt="" loading="lazy" />`
    : '';
  const awayLogo = next.away?.logo
    ? `<img class="next-flag" src="${escapeHtml(next.away.logo)}" alt="" loading="lazy" />`
    : '';
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const showHours = h > 0;
  const block = (val, unit) => `
    <div class="next-block">
      <div class="next-num">${val}</div>
      <div class="next-unit">${unit}</div>
    </div>`;
  const countdownHtml = showHours
    ? `${block(hh, 'Hrs')}<span class="next-sep">:</span>${block(mm, 'Min')}<span class="next-sep">:</span>${block(ss, 'Sec')}`
    : `${block(mm, 'Min')}<span class="next-sep">:</span>${block(ss, 'Sec')}`;
  // Re-rendering the whole innerHTML every second would kill any digit
  // transitions. So: build the static frame once per match change, then
  // only patch the .next-num values on subsequent ticks.
  const sig = `${next.id}|${showHours}`;
  if (nextBannerEl.dataset.sig !== sig) {
    nextBannerEl.hidden = false;
    nextBannerEl.dataset.sig = sig;
    nextBannerEl.innerHTML = `
      <div class="next-meta">
        <span class="next-label">Next match</span>
        <span class="next-when">${escapeHtml(when)}</span>
      </div>
      <div class="next-teams">
        <div class="next-team">${homeLogo}<span class="next-team-name">${escapeHtml(homeName)}</span></div>
        <span class="next-vs">vs</span>
        <div class="next-team">${awayLogo}<span class="next-team-name">${escapeHtml(awayName)}</span></div>
      </div>
      <div class="next-countdown-row">${countdownHtml}</div>
    `;
  } else {
    const nums = nextBannerEl.querySelectorAll('.next-num');
    const vals = showHours ? [hh, mm, ss] : [mm, ss];
    nums.forEach((el, i) => {
      if (el.textContent !== vals[i]) el.textContent = vals[i];
    });
  }
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
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
  updateNextBanner();
  // Refresh stats for any expanded live match.
  for (const id of state.expanded) {
    const ev = state.events.find((e) => e.id === id);
    if (ev && ev.state === 'in') ensureStats(id);
  }
}

ensurePhotoDb();
load();
