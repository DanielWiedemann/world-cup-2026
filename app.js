// World Cup 2026 — fetches fixtures from ESPN's CORS-friendly scoreboard
// endpoint, caches in localStorage, renders in the user's local timezone.

const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const TOURNAMENT_START = '2026-06-11';
const TOURNAMENT_END = '2026-07-19';
const CACHE_KEY = 'wc2026.events.v2'; // v2: events now carry team colors
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LIVE_POLL_MS = 15 * 1000; // poll every 15s while something's live
const KICKOFF_WINDOW_MS = 10 * 60 * 1000; // open the LIVE tab 10 min before kickoff
const LATE_WINDOW_MS = 30 * 60 * 1000; // keep it open up to 30 min past a late start

const STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings';
const STANDINGS_CACHE_KEY = 'wc2026.standings.v1';
const STANDINGS_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
const STATS_CACHE_KEY = 'wc2026.stats.v2';
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
  search: '',
  loading: false,
  expanded: new Set(),
  stats: loadStatsCache(),
  standings: null,
  standingsError: false,
  scorers: null,
  scorersError: false,
  animateNext: true,
  liveSelected: null, // which simultaneous live/imminent game the LIVE tab shows
};
let pollTimer = null;
let nextBannerTimer = null;
// Declared here (before any boot-time call into buildGroupIndex) — `let`
// bindings live in the temporal dead zone until their declaration runs, and
// a cached-standings boot calls buildGroupIndex() immediately below.
let standingsLoading = false;
let groupByAbbr = {};

state.standings = loadStandingsCache();
if (state.standings) buildGroupIndex();
state.scorers = loadScorersCache();

// Event delegation on the filters bar so dynamically-added tabs (the LIVE
// tab) work too.
const filtersBar = document.querySelector('.filters');
let userNavigated = false;
// True while a swipe carousel is on screen. The swipe caches its prev/next
// tabs up front, so we must not let a background poll reorder the tab bar
// (e.g. insert/remove the LIVE tab) mid-gesture and strand the commit on a
// tab that no longer exists.
let swipeActive = false;
filtersBar.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.filter');
  if (!btn) return;
  userNavigated = true; // a real tap — never auto-yank them away after this
  // Tapping a tab leaves preview mode (drops the #preview hash).
  if (previewMode()) history.replaceState(null, '', location.pathname + location.search);
  setFilter(btn.dataset.filter);
});

// Entering/leaving preview mode via the URL hash repaints the app.
window.addEventListener('hashchange', () => render());

function setFilter(filter) {
  state.filter = filter;
  state.animateNext = true;
  closeSearch(); // picking a tab exits search
  filtersBar.querySelectorAll('.filter').forEach((b) =>
    b.classList.toggle('active', b.dataset.filter === filter)
  );
  if (filter === 'scorers') {
    ensureScorers();
    // One-shot: pull live timelines so live goals fold into the Golden Boot
    // immediately on entry (the 30s poll keeps them fresh afterwards).
    for (const e of state.events) if (e.state === 'in') ensureStats(e.id);
  }
  if (filter === 'groups') ensureStandings();
  render(); // also repositions the tab indicator
  // Keep the active tab (and the bubble that lands on it) in view.
  const ab = filtersBar.querySelector('.filter.active');
  ab?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

// --- Team search ----------------------------------------------------------
const searchBtn = $('#search-btn');
const searchBar = $('#search-bar');
const searchInput = $('#search-input');
const searchClear = $('#search-clear');

function openSearch() {
  if (!searchBar) return;
  searchBar.hidden = false;
  searchBtn?.classList.add('on');
  searchInput?.focus();
}
function closeSearch() {
  if (!searchBar || searchBar.hidden) return;
  searchBar.hidden = true;
  searchBtn?.classList.remove('on');
  if (searchInput) searchInput.value = '';
  state.search = '';
}
searchBtn?.addEventListener('click', () => {
  if (searchBar.hidden) openSearch();
  else { closeSearch(); render(); }
});
searchInput?.addEventListener('input', () => {
  state.search = searchInput.value;
  render();
});
searchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSearch(); render(); }
});
searchClear?.addEventListener('click', () => {
  state.search = '';
  if (searchInput) { searchInput.value = ''; searchInput.focus(); }
  render();
});

// Every game involving a team whose name/short/abbr matches the query,
// grouped by day. Drives the search view (overrides the active tab).
function searchHTML() {
  const q = state.search.trim().toLowerCase();
  const hit = (t) =>
    t && [t.name, t.short, t.abbr].some((v) => (v || '').toLowerCase().includes(q));
  const found = state.events.filter((e) => hit(e.home) || hit(e.away));
  if (!found.length) {
    return `<p class="empty">No games match “${escapeHtml(state.search.trim())}”.</p>`;
  }
  const byDay = new Map();
  for (const e of found) {
    const k = localDayKey(e.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  return Array.from(byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([day, evs]) => `
      <section class="day">
        <h2 class="day-header">${escapeHtml(formatDayLabel(day))}</h2>
        ${evs.map(matchCard).join('')}
      </section>`
    )
    .join('');
}

// The white "bubble" behind the active tab. updateIndicator() parks it under
// the active pill; morphIndicator() drives it mid-swipe so it stretches to
// bridge the current and incoming tabs, then settles on the target.
function updateIndicator(animate) {
  const track = filtersBar.querySelector('.filters-track');
  if (!track) return;
  const ind = track.querySelector('.filter-indicator');
  const activeBtn = track.querySelector('.filter.active');
  if (!ind || !activeBtn) return;
  const firstShow = ind.style.opacity !== '1';
  if (!animate || firstShow) ind.style.transition = 'none';
  ind.style.left = activeBtn.offsetLeft + 'px';
  ind.style.width = activeBtn.offsetWidth + 'px';
  ind.style.opacity = '1';
  // Drop any per-pill text colour left over from a swipe.
  track.querySelectorAll('.filter').forEach((b) => { b.style.color = ''; });
  if (!animate || firstShow) {
    void ind.offsetWidth; // commit the no-transition jump before re-enabling
    ind.style.transition = '';
  }
}

function morphIndicator(p, dir) {
  const track = filtersBar.querySelector('.filters-track');
  if (!track) return;
  const ind = track.querySelector('.filter-indicator');
  if (!ind) return;
  if (!dir) { updateIndicator(true); return; }
  const tabs = Array.from(track.querySelectorAll('.filter'));
  const curBtn = track.querySelector('.filter.active');
  const ci = tabs.indexOf(curBtn);
  if (ci < 0) return;
  const ti = (ci + (dir > 0 ? 1 : -1) + tabs.length) % tabs.length;
  const tgtBtn = tabs[ti];
  if (!tgtBtn || tgtBtn === curBtn) return;
  ind.style.transition = 'none';
  ind.style.opacity = '1';
  const a = { l: curBtn.offsetLeft, r: curBtn.offsetLeft + curBtn.offsetWidth };
  const b = { l: tgtBtn.offsetLeft, r: tgtBtn.offsetLeft + tgtBtn.offsetWidth };
  const eIn = (x) => x * x;
  const eOut = (x) => 1 - (1 - x) * (1 - x);
  // The leading edge races ahead (easeOut) while the trailing edge lags
  // (easeIn) — that's what makes the bubble elongate to bridge both tabs,
  // then contract onto the target.
  const movingRight = b.l + b.r > a.l + a.r;
  const left = movingRight
    ? a.l + (b.l - a.l) * eIn(p)
    : a.l + (b.l - a.l) * eOut(p);
  const right = movingRight
    ? a.r + (b.r - a.r) * eOut(p)
    : a.r + (b.r - a.r) * eIn(p);
  ind.style.left = left + 'px';
  ind.style.width = Math.max(0, right - left) + 'px';
  // Cross-fade text: current pill fades to white as the bubble leaves; the
  // target darkens as it arrives. accent-deep ≈ rgb(12,92,60).
  const W = [255, 255, 255], D = [12, 92, 60];
  const mix = (from, to) => from.map((c, i) => Math.round(c + (to[i] - c) * p));
  const cc = mix(D, W), tc = mix(W, D);
  curBtn.style.color = `rgb(${cc[0]},${cc[1]},${cc[2]})`;
  tgtBtn.style.color = `rgb(${tc[0]},${tc[1]},${tc[2]})`;
}

// The LIVE tab appears (far left, red, pulsing) only while a match is in
// progress, and is removed when none are. It shows that match alone.
let liveTabAutoShown = false;
function syncLiveTab() {
  if (swipeActive) return; // never reorder the tab bar during a swipe
  const showTab = liveTabEvents().length > 0; // live OR within the kickoff window
  const anyTrulyLive = state.events.some((e) => e.state === 'in');
  let liveBtn = filtersBar.querySelector('.filter[data-filter="live"]');
  if (showTab && !liveBtn) {
    liveBtn = document.createElement('button');
    liveBtn.className = 'filter filter-live';
    liveBtn.dataset.filter = 'live';
    liveBtn.setAttribute('role', 'tab');
    liveBtn.innerHTML = '<span class="live-dot"></span>LIVE';
    const track = filtersBar.querySelector('.filters-track');
    track.insertBefore(liveBtn, track.querySelector('.filter'));
    updateIndicator(true); // inserting at the front shifts every tab right
  } else if (!showTab && liveBtn) {
    liveBtn.remove();
    liveTabAutoShown = false; // re-arm auto-jump for the next match that goes live
    if (state.filter === 'live') setFilter('today');
    else updateIndicator(true);
    return;
  }
  // Auto-jump to LIVE only once a match is actually in progress (not merely
  // imminent), and only if the user is on the default tab and hasn't
  // navigated — never yank them out of a tab they chose.
  if (anyTrulyLive && !liveTabAutoShown && !userNavigated && state.filter === 'upcoming') {
    liveTabAutoShown = true;
    setFilter('live');
  }
}

// Once the Final is won, a golden "🏆 Champions" tab appears at the front and
// becomes the default landing — the tournament's grand finale greets you first.
let championsAutoShown = false;
function syncChampionsTab() {
  if (swipeActive) return;
  const show = championsReady();
  let champBtn = filtersBar.querySelector('.filter[data-filter="champions"]');
  if (show && !champBtn) {
    champBtn = document.createElement('button');
    champBtn.className = 'filter filter-champions';
    champBtn.dataset.filter = 'champions';
    champBtn.setAttribute('role', 'tab');
    champBtn.innerHTML = '<span class="champ-star">🏆</span>Champions';
    const track = filtersBar.querySelector('.filters-track');
    track.insertBefore(champBtn, track.querySelector('.filter'));
    updateIndicator(true);
  } else if (!show && champBtn) {
    champBtn.remove();
    if (state.filter === 'champions') setFilter('all');
    else updateIndicator(true);
    return;
  }
  // Land on the Champions page by default the first time it's available and the
  // user hasn't navigated elsewhere.
  if (show && !championsAutoShown && !userNavigated) {
    championsAutoShown = true;
    setFilter('champions');
  }
}

refreshBtn.addEventListener('click', () => {
  load({ force: true });
  if (state.filter === 'groups') ensureStandings(true);
  if (state.filter === 'scorers') ensureScorers(true);
});

// Tapping the Next Match banner expands that match's card (same as tapping it
// in the list), then scrolls to it.
nextBannerEl.addEventListener('click', (e) => {
  // A specific matchup row wins; otherwise fall back to the single-game id.
  const row = e.target.closest('.next-match');
  const id = (row && row.dataset.eventId) || nextBannerEl.dataset.eventId;
  if (!id) return;
  state.expanded.add(id);
  render();
  requestAnimationFrame(() => {
    const card = matchesEl.querySelector(`.match[data-event-id="${CSS.escape(id)}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

// --- Swipe between tabs (carousel) ---------------------------------------
// A horizontal drag shifts the current view (and the Next-match banner) with
// the finger, while a fixed layer holds the two neighbouring tabs —
// pre-rendered with viewHTML() — so they slide in to fill the gap. The page
// background never shows through. Tabs wrap around at both ends. We claim the
// horizontal gesture (touch-action: pan-y + preventDefault once engaged) so
// Chrome's back/forward edge-swipe can't hijack it.
(() => {
  if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;
  const headerEl = document.querySelector('.app-header');

  const COMMIT_RATIO = 0.3; // |dx| past 30% of the viewport commits
  const SLOPE = 1.3; // |dx| must beat |dy| * SLOPE to engage horizontally
  const VERTICAL_LIMIT = 70;
  const ANIM_MS = 340; // keep in sync with .swipe-shift-anim duration

  let startX = 0, startY = 0, lastX = 0, lastT = 0, velocity = 0;
  let active = false, engaged = false, cancelled = false;
  let width = 0; // viewport width (gesture distance reference)
  let slide = 0; // content width — how far a commit travels
  let layer = null; // fixed neighbour layer
  let prevTab = null, nextTab = null;

  function inHorizontalScroller(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n.nodeType === 1) {
        if (
          n.classList?.contains('bkt-scroll') ||
          n.classList?.contains('filters') ||
          n.classList?.contains('filters-track')
        ) return true;
        const s = getComputedStyle(n);
        if (
          (s.overflowX === 'auto' || s.overflowX === 'scroll') &&
          n.scrollWidth > n.clientWidth + 2
        ) return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  function tabsInOrder() {
    return Array.from(document.querySelectorAll('.filters .filter')).map(
      (b) => b.dataset.filter
    );
  }

  function neighbours() {
    const tabs = tabsInOrder();
    const i = tabs.indexOf(state.filter);
    return {
      prev: tabs[(i - 1 + tabs.length) % tabs.length],
      next: tabs[(i + 1) % tabs.length],
    };
  }

  // One pane of the carousel: the tab's view, plus the Next-match banner on
  // top when that tab is Upcoming (so the banner slides with its tab).
  function paneInner(filter) {
    const banner =
      filter === 'upcoming' &&
      nextBannerEl && !nextBannerEl.hidden && nextBannerEl.innerHTML.trim()
        ? `<div class="next-banner pane-banner">${nextBannerEl.innerHTML}</div>`
        : '';
    return `${banner}<main class="matches">${viewHTML(filter)}</main>`;
  }

  function buildLayer() {
    const top = Math.round(
      headerEl ? headerEl.getBoundingClientRect().bottom : 0
    );
    // Size and place the panes to the *content* width (matches is centred
    // with a max-width), so the neighbour butts directly against the current
    // view with no gap — even when the viewport is wider than the content.
    const mr = matchesEl.getBoundingClientRect();
    slide = Math.round(mr.width) || window.innerWidth;
    const cl = Math.round(mr.left);
    layer = document.createElement('div');
    layer.className = 'swipe-neighbors';
    layer.style.top = top + 'px';
    layer.setAttribute('aria-hidden', 'true');
    const n = neighbours();
    prevTab = n.prev;
    nextTab = n.next;
    const prev = document.createElement('div');
    prev.className = 'swipe-pane prev';
    prev.style.left = cl - slide + 'px';
    prev.style.width = slide + 'px';
    prev.innerHTML = paneInner(prevTab);
    const next = document.createElement('div');
    next.className = 'swipe-pane next';
    next.style.left = cl + slide + 'px';
    next.style.width = slide + 'px';
    next.innerHTML = paneInner(nextTab);
    layer.append(prev, next);
    document.body.appendChild(layer);
    swipeActive = true; // freeze the tab bar until this gesture resolves
  }

  function shiftEls() {
    const els = [matchesEl];
    if (nextBannerEl && !nextBannerEl.hidden) els.push(nextBannerEl);
    return els;
  }

  function setShift(dx, anim) {
    for (const el of shiftEls()) {
      el.classList.toggle('swipe-shift-anim', !!anim);
      el.style.transform = dx ? `translateX(${dx}px)` : '';
    }
    if (layer) {
      layer.classList.toggle('anim', !!anim);
      layer.style.transform = dx ? `translateX(${dx}px)` : '';
    }
  }

  function clearShift() {
    for (const el of [matchesEl, nextBannerEl]) {
      if (!el) continue;
      el.classList.remove('swipe-shift-anim');
      el.style.transform = '';
    }
    if (layer) { layer.remove(); layer = null; }
    swipeActive = false;
    syncLiveTab(); // reconcile any LIVE-tab change a poll deferred mid-swipe
  }

  // dir +1 = next tab (content slides left), -1 = prev tab (slides right).
  function commit(dir) {
    const target = dir > 0 ? nextTab : prevTab;
    setShift(dir > 0 ? -slide : slide, true);
    morphIndicator(1, dir);
    try { navigator.vibrate?.(12); } catch {}
    setTimeout(() => {
      // The neighbour pane is now centred. Render the real view (still shoved
      // off-screen by the inline transform), then snap it back with no
      // animation so the swap is invisible, and drop the layer.
      swipeActive = false; // unfreeze before setFilter so syncLiveTab can run
      window.scrollTo(0, 0);
      setFilter(target);
      for (const el of [matchesEl, nextBannerEl]) {
        if (!el) continue;
        el.classList.remove('swipe-shift-anim');
        el.style.transform = '';
      }
      if (layer) { layer.remove(); layer = null; }
      syncLiveTab(); // reconcile any LIVE-tab change a poll deferred mid-swipe
    }, ANIM_MS);
  }

  function snapBack() {
    setShift(0, true);
    morphIndicator(0, 0);
    setTimeout(clearShift, ANIM_MS);
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      if (document.querySelector('dialog[open]')) return;
      if (layer) return; // a commit/snap is still animating
      const t = e.touches[0];
      if (inHorizontalScroller(t.target || e.target)) return;
      startX = lastX = t.clientX;
      startY = t.clientY;
      lastT = e.timeStamp || performance.now();
      velocity = 0;
      active = true;
      engaged = false;
      cancelled = false;
      width = window.innerWidth;
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!active || cancelled) return;
      const t = e.touches[0];
      const now = e.timeStamp || performance.now();
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!engaged) {
        // Give up to vertical scrolling early.
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) {
          cancelled = true;
          return;
        }
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * SLOPE) {
          engaged = true;
          buildLayer();
        } else {
          return;
        }
      }
      // We own the gesture now — block native scroll and the edge-swipe.
      if (e.cancelable) e.preventDefault();
      const dt = Math.max(1, now - lastT);
      velocity = (t.clientX - lastX) / dt;
      lastX = t.clientX;
      lastT = now;
      const clamped = Math.max(-slide, Math.min(slide, dx));
      setShift(clamped, false);
      morphIndicator(Math.min(1, Math.abs(clamped) / slide), clamped < 0 ? 1 : -1);
    },
    { passive: false }
  );

  document.addEventListener(
    'touchend',
    (e) => {
      if (!active) return;
      active = false;
      if (!engaged) return;
      engaged = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const passed = Math.abs(dx) > (slide || width) * COMMIT_RATIO;
      const flick =
        Math.abs(velocity) > 0.5 && Math.sign(velocity) === Math.sign(dx);
      if ((passed || flick) && dx !== 0) {
        commit(dx < 0 ? 1 : -1); // swipe LEFT = next tab
      } else {
        snapBack();
      }
    },
    { passive: true }
  );

  document.addEventListener(
    'touchcancel',
    () => {
      if (!active) return;
      active = false;
      if (engaged) snapBack();
      engaged = false;
    },
    { passive: true }
  );
})();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Always catch up on scores when the app comes back to the foreground —
    // a match may have finished while we were hidden. Throttled so flipping
    // back and forth doesn't hammer ESPN.
    pollScores({ throttleMs: 15000 });
    updateNextBanner();
  }
  updateLivePolling();
});
window.addEventListener('focus', () => pollScores({ throttleMs: 15000 }));
window.addEventListener('online', () => pollScores({ throttleMs: 15000 }));

matchesEl.addEventListener('click', (e) => {
  // Live-match switcher chip (when several games run at once).
  const liveChip = e.target.closest('.live-switch-chip');
  if (liveChip) {
    e.stopPropagation();
    if (liveChip.dataset.liveSelect !== state.liveSelected) {
      state.liveSelected = liveChip.dataset.liveSelect;
      render();
    }
    return;
  }
  // Bracket card with a real team → open that game in the schedule.
  const koCardEl = e.target.closest('.bkt-card.tappable[data-event-id]');
  if (koCardEl) {
    const id = koCardEl.dataset.eventId;
    userNavigated = true;
    state.expanded.add(id);
    setFilter('all');
    ensureStats(id);
    requestAnimationFrame(() => {
      const c = matchesEl.querySelector(`.match[data-event-id="${CSS.escape(id)}"]`);
      if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return;
  }
  // SPOTM dropdown: open/close the menu.
  const motmTrigger = e.target.closest('.motm-dd-trigger');
  if (motmTrigger) {
    e.stopPropagation();
    const menu = motmTrigger.parentElement.querySelector('.motm-dd-menu');
    const willOpen = menu.hasAttribute('hidden');
    closeMotmMenus(willOpen ? menu : null);
    if (willOpen) {
      menu.removeAttribute('hidden');
      motmTrigger.setAttribute('aria-expanded', 'true');
    } else {
      menu.setAttribute('hidden', '');
      motmTrigger.setAttribute('aria-expanded', 'false');
    }
    return;
  }
  // SPOTM dropdown: a player row (or "No pick").
  const motmOpt = e.target.closest('.motm-dd-opt');
  if (motmOpt) {
    e.stopPropagation();
    onMotmPickDD(motmOpt);
    return;
  }
  // Share button.
  const shareBtn = e.target.closest('.share-btn');
  if (shareBtn) {
    e.stopPropagation();
    shareMatch(shareBtn.dataset.share);
    return;
  }
  // Prediction stepper buttons.
  const stepBtn = e.target.closest('.pred-step');
  if (stepBtn) {
    e.stopPropagation();
    onPredictionStep(stepBtn);
    return;
  }
  // Save (lock) the prediction.
  const saveBtn = e.target.closest('.pred-save');
  if (saveBtn) {
    e.stopPropagation();
    onPredictionSave(saveBtn.dataset.ev);
    return;
  }
  // Team tap → team sheet. Group tables always open it. On a match card it
  // opens ONLY once the card is expanded; while collapsed the tap falls
  // through to expand the card (so a card tap shows the game info first).
  const teamEl = e.target.closest('.team[data-team-abbr], .gt-team[data-team-abbr]');
  if (teamEl && teamEl.dataset.teamAbbr) {
    const card = teamEl.closest('.match');
    const expandedCard = card && card.classList.contains('expanded');
    if (teamEl.classList.contains('gt-team') || expandedCard) {
      e.stopPropagation();
      openTeamDialog(teamEl.dataset.teamAbbr);
      return;
    }
    // collapsed match card → let it fall through to the card-expand handler
  }
  // Player badge → open overlay (timeline, pitch, scorer list, champion squad).
  const badge = e.target.closest('.tl-badge.photo, .pp-badge.photo, .sc-photo[data-player-photo], .ch-player[data-player-photo]');
  if (badge && badge.dataset.playerPhoto) {
    e.stopPropagation();
    openPlayerDialog(badge.dataset);
    return;
  }
  // Exit preview mode.
  if (e.target.closest('[data-preview-exit]')) {
    e.stopPropagation();
    exitPreview();
    return;
  }
  // Champions page → jump into the full match view with all the stats.
  const champStatsBtn = e.target.closest('.ch-stats-btn[data-champ-stats]');
  if (champStatsBtn) {
    e.stopPropagation();
    const id = champStatsBtn.dataset.champStats;
    userNavigated = true;
    state.expanded.add(id);
    ensureStats(id);
    setFilter('all');
    requestAnimationFrame(() => {
      const c = matchesEl.querySelector(`.match[data-event-id="${CSS.escape(id)}"]`);
      if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
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
  // Interactive prediction controls (the score steppers handle themselves; the
  // SPOTM dropdown opens a native picker) must NOT toggle/collapse the card.
  if (e.target.closest('.pred-motm, .pred-row')) return;
  const card = e.target.closest('.match');
  if (!card) return;
  const id = card.dataset.eventId;
  if (!id) return;
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
  // Load match detail when expanded. Pre matches are fetched too, but only the
  // odds (win probability) are shown for them — the rest is the prediction panel.
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
  if (!playerDialog || !data || !data.playerPhoto) return; // never open an empty shell
  playerDialogPhoto.src = data.playerPhoto;
  playerDialogPhoto.alt = data.playerName || '';
  playerDialogName.textContent = data.playerName || '';
  const team = data.playerTeam || '';
  const pos = POSITION_LONG[data.playerPos] || data.playerPos || '';
  const jersey = data.playerJersey ? `#${data.playerJersey}` : '';
  playerDialogMeta.textContent = [team, pos, jersey].filter(Boolean).join(' · ');
  if (playerDialog.open) playerDialog.close();
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
// Superior Player of the Match dropdown (draft prediction).
// Close any open SPOTM dropdown when tapping elsewhere.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.motm-dd')) closeMotmMenus();
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
  const hScore = home && home.shootoutScore;
  const aScore = away && away.shootoutScore;
  // A knockout draw decided on penalties. shootoutScore + the per-kick takers
  // live ONLY in the scoreboard `details` (the summary feed lacks them).
  let shootout = null;
  if ((Number(hScore) || Number(aScore)) && comp) {
    const sideById = {};
    if (home?.team?.id) sideById[home.team.id] = 'home';
    if (away?.team?.id) sideById[away.team.id] = 'away';
    const takers = (comp.details || [])
      .filter((d) => d.shootout)
      .map((d) => ({
        side: sideById[d.team && d.team.id] || null,
        player:
          (d.athletesInvolved && d.athletesInvolved[0] &&
            (d.athletesInvolved[0].displayName || d.athletesInvolved[0].shortName)) || '',
        scored: !!d.scoringPlay,
      }))
      .filter((t) => t.side);
    shootout = { home: Number(hScore) || 0, away: Number(aScore) || 0, takers };
  }
  return {
    id: ev.id,
    date: ev.date, // ISO UTC
    name: ev.name,
    shortName: ev.shortName,
    // ESPN tags the round on season.slug — 'final', '3rd-place-match', etc.
    // We use this to give the World Cup Final its own epic treatment.
    slug: (ev.season && ev.season.slug) || '',
    state: status.state || 'pre', // pre | in | post
    detail: status.shortDetail || status.detail || '',
    completed: !!status.completed,
    winner: home && home.winner ? 'home' : away && away.winner ? 'away' : null,
    shootout, // null, or { home, away, takers:[{side,player,scored}] }
    home: home && {
      name: home.team.displayName,
      short: home.team.shortDisplayName || home.team.abbreviation,
      abbr: home.team.abbreviation,
      logo: home.team.logo,
      score: home.score,
      shootout: hScore != null ? Number(hScore) : null,
      color: home.team.color ? '#' + home.team.color : '',
    },
    away: away && {
      name: away.team.displayName,
      short: away.team.shortDisplayName || away.team.abbreviation,
      abbr: away.team.abbreviation,
      logo: away.team.logo,
      score: away.score,
      shootout: aScore != null ? Number(aScore) : null,
      color: away.team.color ? '#' + away.team.color : '',
    },
    venue: venue.fullName,
    city: venue.address && venue.address.city,
  };
}

// Only ever inject validated hex colors into inline styles.
function safeHex(c) {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '';
}

function hexToRgb(h) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(h || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Two kit colours are "clashing" if they're perceptually close (e.g. Korea
// and Czechia both red) — the stats bars would be indistinguishable.
function colorsClash(a, b) {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return false;
  const d = Math.sqrt(
    (ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2
  );
  return d < 75;
}

// --- Group standings -------------------------------------------------------

function loadStandingsCache() {
  try {
    const raw = localStorage.getItem(STANDINGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.groups ? parsed : null;
  } catch {
    return null;
  }
}

function buildGroupIndex() {
  groupByAbbr = {};
  for (const g of state.standings?.groups || []) {
    const letter = (g.name || '').replace(/^Group\s+/i, '');
    for (const en of g.entries || []) {
      if (en.abbr) groupByAbbr[en.abbr] = letter;
    }
  }
}

function parseStandings(data) {
  const out = [];
  for (const child of data.children || []) {
    const entries = (child.standings?.entries || []).map((en) => {
      const stat = (name) => en.stats?.find((s) => s.name === name);
      const val = (name) => {
        const s = stat(name);
        return s && typeof s.value === 'number' ? s.value : 0;
      };
      const disp = (name) => stat(name)?.displayValue ?? '0';
      return {
        rank: val('rank') || en.note?.rank || 0,
        name: en.team?.displayName || '',
        abbr: en.team?.abbreviation || '',
        logo: en.team?.logos?.[0]?.href || '',
        gp: disp('gamesPlayed'),
        w: disp('wins'),
        d: disp('ties'), // ESPN names draws "ties"
        l: disp('losses'),
        gd: disp('pointDifferential'), // signed, e.g. "+2"
        pts: disp('points'),
        noteColor: en.note?.color || '',
        noteDesc: en.note?.description || '',
      };
    });
    entries.sort((a, b) => a.rank - b.rank); // entries arrive unsorted
    out.push({ name: child.name || '', entries });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function ensureStandings(force = false) {
  const cached = state.standings;
  if (!force && cached && Date.now() - cached.fetchedAt < STANDINGS_TTL_MS) return;
  if (standingsLoading) return;
  standingsLoading = true;
  try {
    const res = await fetch(STANDINGS_URL);
    if (!res.ok) throw new Error('standings ' + res.status);
    const data = await res.json();
    const groups = parseStandings(data);
    if (groups.length) {
      state.standings = { groups, fetchedAt: Date.now() };
      state.standingsError = false;
      try {
        localStorage.setItem(STANDINGS_CACHE_KEY, JSON.stringify(state.standings));
      } catch {}
      buildGroupIndex();
      render();
    }
  } catch (err) {
    console.error('standings failed', err);
    if (!state.standings) {
      state.standingsError = true;
      if (state.filter === 'groups') render();
    }
  } finally {
    standingsLoading = false;
  }
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

// Matches that belong in the LIVE tab: in progress, or within 10 min of
// kickoff — and we keep them there up to 30 min past a scheduled start that
// hasn't flipped to live yet (a delayed kickoff).
function liveTabEvents() {
  const now = Date.now();
  return state.events.filter((e) => {
    if (e.state === 'in') return true;
    if (e.state === 'pre') {
      const t = new Date(e.date).getTime();
      return t - now <= KICKOFF_WINDOW_MS && now - t < LATE_WINDOW_MS;
    }
    return false;
  });
}

function hasActiveMatches() {
  return liveTabEvents().length > 0;
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

function totalGoals(e) {
  return (parseInt(e.home?.score, 10) || 0) + (parseInt(e.away?.score, 10) || 0);
}

// --- The Final -------------------------------------------------------------
// ESPN slugs the championship match 'final'. It gets the whole app's special
// treatment: an epic golden LIVE stage, and a Champions page once it's over.
function isFinalMatch(e) {
  return !!e && e.slug === 'final';
}
function finalMatch() {
  return state.events.find(isFinalMatch) || null;
}
// The winning side of a finished match: 'home' | 'away' | null. Falls back to
// the scoreline (incl. penalty shootout) if ESPN hasn't flagged a winner yet.
function winnerSide(e) {
  if (!e) return null;
  if (e.winner) return e.winner;
  if (e.state !== 'post') return null;
  if (e.shootout) {
    if (e.shootout.home > e.shootout.away) return 'home';
    if (e.shootout.away > e.shootout.home) return 'away';
  }
  const h = parseInt(e.home?.score, 10) || 0;
  const a = parseInt(e.away?.score, 10) || 0;
  if (h > a) return 'home';
  if (a > h) return 'away';
  return null;
}
// The Champions page is live once the final has finished with a winner.
function championsReady() {
  const f = finalMatch();
  return !!(f && f.state === 'post' && winnerSide(f));
}

// Dates worth re-fetching for fresh scores: yesterday (overnight finals),
// today, tomorrow, plus any currently-live match's date.
function recentDateSet() {
  const now = new Date();
  const set = new Set([ymd(now)]);
  for (const d of [-1, 1]) {
    const x = new Date(now);
    x.setUTCDate(x.getUTCDate() + d);
    set.add(ymd(x));
  }
  for (const e of state.events) {
    if (e.state === 'in') set.add(ymd(new Date(e.date)));
  }
  return set;
}

let lastPollAt = 0;
let pollInFlight = false;

// Lightweight score refresh (a handful of dates). Used by the 30s live
// interval AND on focus/visibility/online, so a finished match's final score
// shows up without a manual refresh. Guarded so two polls — or a poll and a
// full load() — can't race and clobber each other's merge of state.events.
async function pollScores({ celebrate = true, throttleMs = 0 } = {}) {
  if (pollInFlight || state.loading) return;
  if (throttleMs && Date.now() - lastPollAt < throttleMs) return;
  pollInFlight = true;
  lastPollAt = Date.now();
  try {
    const prevTotals = new Map(
      state.events.filter((e) => e.state === 'in').map((e) => [e.id, totalGoals(e)])
    );
    const prevStates = new Map(state.events.map((e) => [e.id, e.state]));
    const results = await Promise.allSettled([...recentDateSet()].map(fetchDate));
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
    syncLiveTab();
    syncChampionsTab();
    // Which live matches just had their score tick up this poll.
    const scored = state.events.filter(
      (e) =>
        e.state === 'in' &&
        prevTotals.get(e.id) != null &&
        totalGoals(e) > prevTotals.get(e.id)
    );
    const justFinished = state.events.some(
      (e) => e.state === 'post' && prevStates.get(e.id) === 'in'
    );
    // A finished match settles into the official season leaderboard.
    if (justFinished) ensureScorers(true);
    // Refresh every live match's timeline (drives the live Golden Boot). Use a
    // SINGLE call per match — forced for the ones that just scored — so the
    // forced refetch isn't pre-empted by a non-forced call that already set the
    // in-flight `loading` guard (which used to swallow the "who scored" fetch).
    for (const e of state.events) {
      if (e.state === 'in') ensureStats(e.id, { force: scored.includes(e) });
    }
    // ESPN's keyEvents (who scored) lags the scoreboard, so the forced refetch
    // above often still lacks the scorer. Chase it: keep refetching the match
    // until its timeline accounts for the new score (drives the Scorers tab).
    for (const e of scored) scheduleScorerReconcile(e.id);
    render();
    resolvePredictionStats(); // pull timelines so final points + MOTM resolve
    if (predictionsDialog?.open) renderPredictionsList();
    // Celebrate once per poll if anything was scored.
    if (celebrate && scored.length) celebrateGoal(scored[0].id);
  } catch (err) {
    console.error('Score poll failed', err);
  } finally {
    pollInFlight = false;
  }
}

// The live interval poller while a match is active.
const livePoll = () => pollScores({ celebrate: true });

// Goal-ish timeline entries (the ones that move the scoreline) for a match.
function timelineGoalCount(entry, ev) {
  if (!entry || !entry.timeline) return 0;
  return entry.timeline.filter(
    (t) => t.kind === 'goal' || t.kind === 'penalty-goal' || t.kind === 'own-goal'
  ).length;
}

// ESPN updates the scoreboard score before its match summary lists who scored.
// After a goal we briefly chase that match's summary (every few seconds, a few
// times) until the timeline's goal count catches up to the scoreboard — so the
// Scorers tab and the match timeline reflect the goal within seconds, not on
// the next 15s poll. One chaser per match; it self-stops when caught up, the
// match ends, or it runs out of attempts. The poll already forced one refetch
// at t=0, so this only handles the follow-ups.
const reconcileTimers = new Map();
function scheduleScorerReconcile(eventId) {
  if (reconcileTimers.has(eventId)) return;
  let tries = 0;
  const stop = () => {
    const t = reconcileTimers.get(eventId);
    if (t) clearInterval(t);
    reconcileTimers.delete(eventId);
  };
  const tick = async () => {
    tries += 1;
    const ev = state.events.find((e) => e.id === eventId);
    // Stop chasing if the match ended, vanished, or the app went to the
    // background — the regular poll (and the on-return catch-up poll) take over.
    if (!ev || ev.state !== 'in' || document.hidden) return stop();
    await ensureStats(eventId, { force: true });
    const caughtUp = timelineGoalCount(state.stats[eventId], ev) >= totalGoals(ev);
    if (caughtUp || tries >= 6) stop();
  };
  reconcileTimers.set(eventId, setInterval(tick, 6000));
}

// --- Goal celebration ------------------------------------------------------

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function celebrateGoal(eventId) {
  if (document.hidden) return;
  try { navigator.vibrate?.([90, 40, 90]); } catch {}
  const card = matchesEl.querySelector(
    `.match[data-event-id="${CSS.escape(eventId)}"]`
  );
  if (card) {
    card.classList.remove('goal-flash');
    void card.offsetWidth; // restart animation
    card.classList.add('goal-flash');
  }
  if (!prefersReducedMotion()) fireConfetti();
}

function fireConfetti(durationMs = 2000) {
  if (document.querySelector('.confetti-canvas')) return; // one at a time
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#ffd45c', '#19c37d', '#ffffff', '#ff8a3d', '#1da7ff'];
  const parts = Array.from({ length: 140 }, () => ({
    x: Math.random() * innerWidth,
    y: -30 - Math.random() * innerHeight * 0.25,
    w: 5 + Math.random() * 6,
    h: 8 + Math.random() * 7,
    vx: -1.6 + Math.random() * 3.2,
    vy: 2.2 + Math.random() * 3.4,
    rot: Math.random() * Math.PI,
    vr: -0.18 + Math.random() * 0.36,
    color: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    const elapsed = t - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const fade = Math.max(0, 1 - elapsed / durationMs);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.vy += 0.06;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (elapsed < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  })(t0);
}

// A push notification opens the app with ?match=<eventId> — jump to that game,
// expand it, and scroll to it. Fires once, as soon as the event is loaded.
let deepLinkHandled = false;
function handleMatchDeepLink() {
  if (deepLinkHandled) return;
  const id = new URLSearchParams(location.search).get('match');
  if (!id) { deepLinkHandled = true; return; }
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return; // events not loaded yet — try again on the next render
  deepLinkHandled = true;
  userNavigated = true;
  const liveTabExists = !!filtersBar.querySelector('.filter[data-filter="live"]');
  setFilter(ev.state === 'in' && liveTabExists ? 'live' : 'all');
  state.expanded.add(id);
  if (ev.state !== 'pre') ensureStats(id);
  render();
  requestAnimationFrame(() => {
    const card = matchesEl.querySelector(`.match[data-event-id="${CSS.escape(id)}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  // Drop the param so a manual refresh doesn't keep forcing this match.
  try { history.replaceState(null, '', location.pathname); } catch {}
}

async function load({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;

  const cached = loadCache();
  if (cached && !force && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    state.events = cached.events;
    setUpdated(cached.fetchedAt);
    render();
    handleMatchDeepLink();
    state.loading = false;
    // The full fixture cache is still warm, but recent results may have moved
    // on (a final score, a kickoff). Do a cheap recent-dates refresh so the
    // user never sees a stale score on open.
    pollScores();
    return;
  }

  if (cached) {
    state.events = cached.events;
    setUpdated(cached.fetchedAt);
    render();
    handleMatchDeepLink();
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
    syncLiveTab();
    syncChampionsTab();
    render();
    handleMatchDeepLink();
    resolvePredictionStats();
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
    // Only matches that haven't kicked off — a live game isn't "upcoming".
    // Pre matches in the 10-min-before window are still 'pre', so they stay
    // here as well as appearing in the LIVE tab.
    return events.filter(
      (e) => e.state === 'pre' && new Date(e.date).getTime() > now - LATE_WINDOW_MS
    );
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
  // data-team-abbr marks a resolvable team. On a COLLAPSED card a tap just
  // expands the card; once the card is OPEN, tapping the team opens its sheet
  // (handled in the matchesEl click listener).
  const team = t.abbr && ABBR_TO_GUARDIAN[t.abbr]
    ? ` data-team-abbr="${escapeHtml(t.abbr)}"`
    : '';
  return `<div class="team"${team}>${logo}<span class="team-name">${escapeHtml(t.short || t.name || '')}</span></div>`;
}

function matchAccent(e) {
  const c1 = safeHex(e.home?.color);
  const c2 = safeHex(e.away?.color);
  if (!c1 && !c2) return '';
  return `<div class="match-accent" style="background:linear-gradient(90deg, ${c1 || 'transparent'} 0%, transparent 42%, transparent 58%, ${c2 || 'transparent'} 100%)"></div>`;
}

function groupChip(e) {
  const gh = e.home?.abbr && groupByAbbr[e.home.abbr];
  const ga = e.away?.abbr && groupByAbbr[e.away.abbr];
  if (!gh || gh !== ga) return ''; // knockout / unknown
  return `<span class="group-chip">Group ${escapeHtml(gh)}</span>`;
}

const SHARE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9a3 3 0 1 0 0 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92z"/></svg>`;
const LOCK_ICON = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm3 8H9V6a3 3 0 0 1 6 0v3z"/></svg>`;

function flagWatermarks(e) {
  const h = e.home?.logo
    ? `<img class="flag-wm home" src="${escapeHtml(e.home.logo)}" alt="" loading="lazy" aria-hidden="true" />`
    : '';
  const a = e.away?.logo
    ? `<img class="flag-wm away" src="${escapeHtml(e.away.logo)}" alt="" loading="lazy" aria-hidden="true" />`
    : '';
  return h + a;
}

function predictionChip(e) {
  if (e.state === 'pre') {
    const p = getPrediction(e.id);
    if (!p) return '';
    const motm = p.motm
      ? ` <span class="pred-chip-motm">⭐ ${escapeHtml(p.motm.name.split(' ').pop())}</span>`
      : '';
    return `<span class="pred-chip">🎯 ${p.h}–${p.a}${motm}</span>`;
  }
  // live or post: show running points if a call was made
  const total = predictionTotal(e);
  if (total == null) return '';
  const cls = e.state === 'post' ? (total > 0 ? 'won' : 'lost') : 'live';
  return `<span class="pred-chip ${cls}">🎯 ${e.state === 'post' ? '+' : ''}${total}${e.state === 'in' ? ' pts' : ''}</span>`;
}

function matchCard(e, { hero = false, forceExpand = false } = {}) {
  const live = e.state === 'in';
  const done = e.state === 'post';
  const upcoming = e.state === 'pre';
  const isExpanded = forceExpand || state.expanded.has(e.id);
  const pensLine = e.shootout
    ? `<div class="score-pens">${e.winner === 'home' ? `<b>${e.shootout.home}</b>` : e.shootout.home}–${e.winner === 'away' ? `<b>${e.shootout.away}</b>` : e.shootout.away} pens</div>`
    : '';
  const score =
    !upcoming && e.home && e.away
      ? `<div class="score"><span>${escapeHtml(e.home.score)}</span><span class="dash">–</span><span>${escapeHtml(e.away.score)}</span>${pensLine}</div>`
      : `<div class="kickoff">${formatTime(e.date)}</div>`;
  const badge = live
    ? `<span class="badge live">● Live · ${escapeHtml(e.detail)}</span>`
    : done
    ? `<span class="badge done">FT</span>`
    : '';
  const venue = e.venue
    ? `<div class="venue">${escapeHtml(e.venue)}${e.city ? ', ' + escapeHtml(e.city) : ''}</div>`
    : '';
  const statsBlock = isExpanded
    ? upcoming
      ? renderPredictionPanel(e)
      : renderStats(e)
    : '';
  // The expanded game info now leads with a header (tap a team → team sheet,
  // plus the share button, which used to clutter the main card) and the
  // bookmaker win-probability bar.
  const gameInfo = isExpanded
    ? `<div class="game-info">${gameInfoHeader(e)}${oddsWidget(e)}${statsBlock}</div>`
    : '';
  const hint = forceExpand
    ? ''
    : `<span class="expand-hint" aria-hidden="true">${isExpanded ? '▴' : '▾'}</span>`;
  // Live hero gets a team-colour glow.
  const heroGlow =
    hero && safeHex(e.home?.color)
      ? ` style="--glow-h:${safeHex(e.home.color)};--glow-a:${safeHex(e.away?.color) || safeHex(e.home.color)}"`
      : '';
  return `
    <article class="match ${e.state}${isExpanded ? ' expanded' : ''} expandable${hero ? ' hero' : ''}" data-event-id="${escapeHtml(e.id)}"${heroGlow}>
      ${matchAccent(e)}
      ${flagWatermarks(e)}
      <div class="match-top">
        ${teamMarkup(e.home)}
        ${score}
        ${teamMarkup(e.away)}
      </div>
      <div class="match-bottom">
        ${badge}
        ${groupChip(e)}
        ${predictionChip(e)}
        ${venue}
        ${hint}
      </div>
      ${gameInfo}
    </article>
  `;
}

// Header for the expanded game info: a hint that the teams up top are tappable
// (→ team sheet), plus the share button (kept off the busy main card).
function gameInfoHeader(e) {
  const tappable = ABBR_TO_GUARDIAN[e.home?.abbr] || ABBR_TO_GUARDIAN[e.away?.abbr];
  const hint = tappable
    ? '<span class="game-info-hint">Tap a country above for squad &amp; stats</span>'
    : '';
  const share = e.state !== 'pre'
    ? `<button type="button" class="share-btn" data-share="${escapeHtml(e.id)}" aria-label="Share result" title="Share">${SHARE_ICON}</button>`
    : '';
  if (!hint && !share) return '';
  return `
    <div class="game-info-head">
      ${hint}
      <span class="spacer"></span>
      ${share}
    </div>`;
}

// American moneyline → implied probability (0–1).
function impliedFromMoneyline(ml) {
  if (ml == null || !Number.isFinite(ml)) return null;
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}

// Bookmaker win/draw/win bar, normalised to remove the overround. Pre + live
// only (a finished result makes pre-match odds moot).
function oddsWidget(e) {
  const o = state.stats[e.id]?.odds;
  if (!o) return ''; // no bookmaker line for this match
  // Gated behind a saved prediction: predict first, then the bar reveals (and
  // stays visible afterwards, even once the game is over).
  if (!getPrediction(e.id)) {
    return e.state === 'pre'
      ? `<div class="odds locked">
           <h3 class="stats-section-title">Win probability</h3>
           <p class="odds-locked">🔒 Save your prediction below to reveal the win probability.</p>
         </div>`
      : '';
  }
  const hc = safeHex(e.home?.color) || 'var(--accent)';
  const rawH = safeHex(e.home?.color);
  const rawA = safeHex(e.away?.color);
  let ac = rawA || '#5a8bd6';
  if (rawH && rawA && colorsClash(rawH, rawA)) ac = `color-mix(in srgb, ${rawA} 42%, #ffffff)`;
  const seg = (pct, cls, style) =>
    pct > 0 ? `<div class="odds-seg ${cls}" style="width:${pct}%;${style || ''}"></div>` : '';
  const leg = (pct, label, color) =>
    `<span class="odds-leg"><span class="odds-dot" style="background:${color}"></span><b>${pct}%</b> ${escapeHtml(label)}</span>`;
  return `
    <div class="odds">
      <h3 class="stats-section-title">Win probability</h3>
      <div class="odds-bar" aria-hidden="true">
        ${seg(o.home, 'home', `background:${hc}`)}
        ${o.hasDraw ? seg(o.draw, 'draw', '') : ''}
        ${seg(o.away, 'away', `background:${ac}`)}
      </div>
      <div class="odds-legend">
        ${leg(o.home, e.home?.short || e.home?.abbr || 'Home', hc)}
        ${o.hasDraw ? leg(o.draw, 'Draw', 'var(--muted)') : ''}
        ${leg(o.away, e.away?.short || e.away?.abbr || 'Away', ac)}
      </div>
      <p class="odds-src">Implied by ${escapeHtml(o.provider || 'bookmaker')} odds${o.live ? ' · live' : ''}</p>
    </div>`;
}

async function shareMatch(id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev || !ev.home || !ev.away) return;
  const h = ev.home;
  const a = ev.away;
  let text;
  if (ev.state === 'post') {
    text = `FT: ${h.name} ${h.score}–${a.score} ${a.name} ⚽ #WorldCup2026`;
  } else if (ev.state === 'in') {
    text = `LIVE ${ev.detail}: ${h.name} ${h.score}–${a.score} ${a.name} ⚽ #WorldCup2026`;
  } else {
    const when = new Date(ev.date).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    text = `${h.name} vs ${a.name} — ${when} ⚽ #WorldCup2026`;
  }
  const url = location.origin + location.pathname;
  try {
    if (navigator.share) {
      await navigator.share({ text, url });
    } else {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setStatus('Copied to clipboard');
      setTimeout(() => setStatus(''), 2000);
    }
  } catch {} // user cancelled the share sheet — fine
}

// --- Golden Boot (top scorers) ----------------------------------------------
//
// ESPN's pre-aggregated `statistics` leaders feed is unreliable mid-tournament:
// it lags days behind AND silently omits players (e.g. a hat-trick hero just
// missing from the list). So we compute the Golden Boot ourselves from the
// authoritative per-match data — each day's scoreboard carries a `details`
// array of scoring plays (scorer, team, penalty/own-goal flags) — aggregating
// goals across every finished match. Assists aren't in that feed, so the
// (secondary) assists list still comes from ESPN's aggregate.

const SCORERS_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/statistics?season=2026';
const SCORERS_CACHE_KEY = 'wc2026.scorers.v2'; // v2: goals computed locally
const GBDATES_CACHE_KEY = 'wc2026.gbdates.v1'; // per-day goal cache
const SCORERS_TTL_MS = 5 * 60 * 1000;
let scorersLoading = false;

function loadScorersCache() {
  try {
    const raw = localStorage.getItem(SCORERS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.goals ? parsed : null;
  } catch {
    return null;
  }
}

// Per-day goal cache. A day whose games are all finished never changes, so we
// keep those permanently (across sessions); days with a live/upcoming game are
// refetched. Keyed by YYYYMMDD.
const goldenBootDateCache = new Map();
(function loadGBDateCache() {
  try {
    const obj = JSON.parse(localStorage.getItem(GBDATES_CACHE_KEY) || '{}');
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.allFinal && Array.isArray(v.goals)) goldenBootDateCache.set(k, v);
    }
  } catch {}
})();
function saveGBDateCache() {
  try {
    const obj = {};
    for (const [k, v] of goldenBootDateCache) if (v.allFinal) obj[k] = v;
    localStorage.setItem(GBDATES_CACHE_KEY, JSON.stringify(obj));
  } catch {}
}

// Goals from one day's scoreboard `details`. Only finished games count toward
// the tally (live games are layered on via liveGoalTally); `allFinal` flags
// whether the day is safe to cache permanently.
async function fetchDateGoals(dateStr) {
  const res = await fetch(`${ESPN_BASE}?dates=${dateStr}&limit=100`);
  if (!res.ok) throw new Error('scoreboard ' + res.status);
  const data = await res.json();
  const goals = [];
  let allFinal = true;
  for (const ev of data.events || []) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    if ((ev.status?.type?.state) !== 'post') {
      allFinal = false; // a live/upcoming game here — don't cache this day yet
      continue;
    }
    const teamById = {};
    for (const c of comp.competitors || []) {
      teamById[c.team?.id] = {
        abbr: c.team?.abbreviation || '',
        name: c.team?.shortDisplayName || c.team?.displayName || '',
        logo: c.team?.logos?.[0]?.href || c.team?.logo || '',
      };
    }
    for (const dt of comp.details || []) {
      if (!dt.scoringPlay || dt.ownGoal) continue; // goals only; own goals excluded
      const a = (dt.athletesInvolved || [])[0];
      if (!a) continue;
      const tm = teamById[dt.team?.id] || {};
      goals.push({
        athleteId: a.id || '',
        name: a.displayName || a.shortName || '?',
        jersey: a.jersey || '',
        teamAbbr: tm.abbr || '',
        teamName: tm.name || '',
        teamLogo: tm.logo || '',
        pen: !!dt.penaltyKick,
      });
    }
  }
  return { goals, allFinal };
}

function parseLeaders(category) {
  return (category?.leaders || [])
    .filter((l) => (l.value || 0) > 0)
    .map((l) => {
      const a = l.athlete || {};
      const statVal = (name) =>
        a.statistics?.find((s) => s.name === name)?.value ?? 0;
      return {
        name: a.displayName || a.shortName || '?',
        shortName: a.shortName || a.displayName || '?',
        jersey: a.jersey || '',
        teamAbbr: a.team?.abbreviation || '',
        teamName: a.team?.displayName || '',
        teamLogo: a.team?.logos?.[0]?.href || '',
        value: l.value || 0,
        apps: statVal('appearances'),
        goals: statVal('totalGoals'),
        assists: statVal('goalAssists'),
      };
    });
}

async function ensureScorers(force = false) {
  const cached = state.scorers;
  if (!force && cached && Date.now() - cached.fetchedAt < SCORERS_TTL_MS) return;
  // While a match is live, keep the finished-games snapshot stable — mergedGoals()
  // overlays live goals on top, so a mid-match recompute could briefly double up.
  // Full time forces a clean recompute via pollScores().
  if (!force && cached && state.events.some((e) => e.state === 'in')) return;
  if (scorersLoading) return;
  scorersLoading = true;
  try {
    // Every day that has a finished match (reuse the permanent cache for days
    // whose games are all done; only today / live days actually refetch).
    const days = [
      ...new Set(
        state.events
          .filter((e) => e.state === 'post')
          .map((e) => ymd(new Date(e.date)))
      ),
    ];
    const perDay = await Promise.all(
      days.map(async (d) => {
        const c = goldenBootDateCache.get(d);
        if (c && c.allFinal) return c;
        try {
          const fresh = await fetchDateGoals(d);
          goldenBootDateCache.set(d, fresh);
          return fresh;
        } catch {
          return c || { goals: [], allFinal: false };
        }
      })
    );
    saveGBDateCache();
    // Aggregate goals per player.
    const tally = new Map();
    for (const day of perDay) {
      for (const g of day.goals) {
        const key = g.athleteId || `${lastNameKey(g.name)}|${g.teamAbbr}`;
        const cur =
          tally.get(key) ||
          {
            name: g.name, shortName: g.name, jersey: g.jersey,
            teamAbbr: g.teamAbbr, teamName: g.teamName, teamLogo: g.teamLogo,
            value: 0, goals: 0, pens: 0, assists: 0,
          };
        cur.value += 1;
        cur.goals += 1;
        if (g.pen) cur.pens += 1;
        if (g.jersey) cur.jersey = g.jersey;
        tally.set(key, cur);
      }
    }
    const goals = [...tally.values()].sort(
      (a, b) =>
        b.value - a.value ||
        b.goals - a.goals ||
        (a.name || '').localeCompare(b.name || '')
    );
    // Assists: ESPN's aggregate (the scoreboard feed carries no assist data).
    let assists = (cached && cached.assists) || [];
    try {
      const sdata = await (await fetch(SCORERS_URL)).json();
      const assistsCat = (sdata.stats || []).find((s) => s.name === 'assistsLeaders');
      if (assistsCat) assists = parseLeaders(assistsCat);
    } catch {}
    state.scorers = { goals, assists, fetchedAt: Date.now() };
    try {
      localStorage.setItem(SCORERS_CACHE_KEY, JSON.stringify(state.scorers));
    } catch {}
    if (state.filter === 'scorers') render();
  } catch (err) {
    console.error('scorers failed', err);
    if (state.filter === 'scorers' && !state.scorers) {
      state.scorersError = true;
      render();
    }
  } finally {
    scorersLoading = false;
  }
}

function scorerRow(p, i, statLabel) {
  const photo = photoFor(p.teamAbbr, p.jersey);
  const badge = photo
    ? `<span class="sc-photo" data-player-photo="${escapeHtml(photo)}" data-player-name="${escapeHtml(p.name)}" data-player-team="${escapeHtml(p.teamName)}" data-player-pos="" data-player-jersey="${escapeHtml(p.jersey)}" role="button" tabindex="0"><img src="${escapeHtml(photo)}" alt="" loading="lazy" /></span>`
    : `<span class="sc-photo placeholder">${escapeHtml(p.jersey || '?')}</span>`;
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
  const liveTag = p.live ? '<span class="sc-live"><span class="sc-live-dot"></span>LIVE</span>' : '';
  // Goals come from our own tally (no "appearances" field); surface penalties
  // instead. Assists still come from ESPN's aggregate, which has appearances.
  const extra =
    statLabel === 'goals'
      ? p.pens
        ? `${p.pens} pen${p.pens === 1 ? '' : 's'}`
        : p.live
        ? 'scoring now'
        : ''
      : p.apps
      ? `${p.apps} app${p.apps === 1 ? '' : 's'}`
      : '';
  return `
    <div class="sc-row ${i === 0 ? 'leader' : ''}${p.live ? ' live' : ''}">
      <span class="sc-rank">${medal}</span>
      ${badge}
      <div class="sc-id">
        <span class="sc-name">${escapeHtml(p.name)}${liveTag}</span>
        <span class="sc-team">${p.teamLogo ? `<img src="${escapeHtml(p.teamLogo)}" alt="" loading="lazy" />` : ''}${escapeHtml(p.teamName)}</span>
      </div>
      <div class="sc-stat">
        <span class="sc-val">${p.value}</span>
        <span class="sc-unit">${statLabel}</span>
      </div>
      <span class="sc-extra">${escapeHtml(extra)}</span>
    </div>`;
}

// Goals scored in currently-live matches, keyed by player+team. The season
// statistics feed only updates around full time, so we fold live goals in on
// top of it to keep the Golden Boot current during a match.
function liveGoalTally() {
  const tally = new Map();
  for (const e of state.events) {
    if (e.state !== 'in') continue;
    const entry = state.stats[e.id];
    if (!entry || !entry.timeline) continue;
    for (const t of entry.timeline) {
      if (t.kind !== 'goal' && t.kind !== 'penalty-goal') continue; // not own goals
      if (!t.player || t.player === '?') continue;
      const side = timelineSide(t, e);
      const team = side === 'home' ? e.home : e.away;
      const rp = findRosterPlayer(entry.lineups, side, t.athleteId, t.player);
      const key = `${lastNameKey(t.player)}|${team?.abbr || ''}`;
      const cur = tally.get(key) || {
        name: t.player,
        jersey: rp?.jersey || '',
        teamAbbr: team?.abbr || '',
        teamName: team?.short || team?.name || '',
        teamLogo: team?.logo || '',
        goals: 0,
        pens: 0,
      };
      cur.goals += 1;
      if (t.kind === 'penalty-goal') cur.pens += 1;
      if (rp?.jersey) cur.jersey = rp.jersey;
      tally.set(key, cur);
    }
  }
  return tally;
}

// Season goals leaderboard with any live goals merged in (and flagged live).
function mergedGoals() {
  const base = (state.scorers?.goals || []).map((p) => ({ ...p }));
  const byKey = new Map(
    base.map((p) => [`${lastNameKey(p.shortName || p.name)}|${p.teamAbbr}`, p])
  );
  for (const [key, lg] of liveGoalTally()) {
    const hit = byKey.get(key);
    if (hit) {
      hit.value = (hit.value || 0) + lg.goals;
      hit.goals = (hit.goals || 0) + lg.goals;
      hit.pens = (hit.pens || 0) + (lg.pens || 0);
      hit.live = true;
    } else {
      const np = {
        name: lg.name, shortName: lg.name, jersey: lg.jersey,
        teamAbbr: lg.teamAbbr, teamName: lg.teamName, teamLogo: lg.teamLogo,
        value: lg.goals, goals: lg.goals, pens: lg.pens || 0, assists: 0, live: true,
      };
      byKey.set(key, np);
      base.push(np);
    }
  }
  base.sort(
    (a, b) =>
      b.value - a.value ||
      (b.goals || 0) - (a.goals || 0) ||
      (a.name || '').localeCompare(b.name || '')
  );
  return base;
}

function scorersHTML() {
  const s = state.scorers;
  const goalsList = mergedGoals();
  if ((!s || (!s.goals?.length && !s.assists?.length)) && !goalsList.length) {
    return state.scorersError
      ? `<p class="empty">Couldn't load scorers. Try again later.</p>`
      : `${Array.from({ length: 6 }, () => '<div class="skeleton-card"></div>').join('')}`;
  }
  const goals = goalsList.slice(0, 20);
  const assists = (s?.assists || []).slice(0, 10);
  return `
    <section class="day">
      <h2 class="day-header">👑 Golden Boot</h2>
      <div class="sc-list">
        ${goals.map((p, i) => scorerRow(p, i, 'goals')).join('') || '<p class="empty">No goals yet.</p>'}
      </div>
    </section>
    <section class="day">
      <h2 class="day-header">🎩 Top assists</h2>
      <div class="sc-list">
        ${assists.map((p, i) => scorerRow(p, i, 'assists')).join('') || '<p class="empty">No assists yet.</p>'}
      </div>
    </section>`;
}

function renderScorersView() {
  matchesEl.innerHTML = scorersHTML();
  ensureScorers();
  // NB: live match timelines are kept fresh by the 30s poll and on tab entry
  // (see setFilter) — NOT here, or render()→ensureStats()→render() would cycle.
  const s = state.scorers;
  if (s && (s.goals?.length || s.assists?.length)) applyEntranceAnimation();
}

// --- Knockout bracket --------------------------------------------------------
//
// A real bracket tree needs to know which match feeds which — i.e. each game's
// FIFA match number (M73–M104). ESPN's site scoreboard feed doesn't carry it,
// so we read it from ESPN's core API (one tiny request per game, cached
// permanently since a match number never changes) and slot each game into the
// fixed 2026 layout. Rendered as a horizontal-scroll tree with connector lines
// — the classic bracket, sized for a phone.

// Fixed display order per round (top→bottom). Adjacent pairs feed the next
// round's match, so a column spaced evenly auto-aligns each match between its
// two feeders. Verified against ESPN match numbers (and the official chart).
const BRACKET_ORDER = {
  r32: [74, 77, 73, 75, 83, 84, 81, 82, 76, 78, 79, 80, 86, 88, 85, 87],
  r16: [89, 90, 93, 94, 91, 92, 95, 96],
  qf: [97, 98, 99, 100],
  sf: [101, 102],
  final: [104],
};
const THIRD_PLACE_MATCH = 103;
const MATCHNUM_CACHE_KEY = 'wc2026.matchnums.v2';
let matchNums = (() => {
  try { return JSON.parse(localStorage.getItem(MATCHNUM_CACHE_KEY)) || {}; } catch { return {}; }
})();
let matchNumsLoading = false;

function knockoutEvents() {
  return state.events.filter(
    (e) => new Date(e.date).getTime() >= new Date('2026-06-28T00:00:00Z').getTime()
  );
}

// ESPN's matchNumber lives in the core API, not the site scoreboard. Fetch the
// ones we don't have yet (cached permanently), then re-render the bracket.
async function ensureMatchNumbers() {
  const missing = knockoutEvents().filter((e) => !matchNums[e.id]);
  if (!missing.length || matchNumsLoading) return;
  matchNumsLoading = true;
  try {
    const results = await Promise.allSettled(
      missing.map(async (e) => {
        const url = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${e.id}/competitions/${e.id}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('core ' + res.status);
        const data = await res.json();
        return { id: e.id, n: data && data.matchNumber };
      })
    );
    let got = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.n) {
        matchNums[r.value.id] = r.value.n;
        got++;
      }
    }
    if (got) {
      try { localStorage.setItem(MATCHNUM_CACHE_KEY, JSON.stringify(matchNums)); } catch {}
      if (state.filter === 'bracket' && !state.search.trim()) render();
    }
  } finally {
    matchNumsLoading = false;
  }
}

// A real qualified team (vs a "Winner of…" placeholder).
function isRealTeam(t) {
  return !!(t && /^[A-Z]{2,4}$/.test(t.abbr || ''));
}

// Tidy a placeholder name like "Round of 16 3 Winner" → "R16.3 winner".
function prettyPlaceholder(t) {
  let s = `${(t && (t.name || t.abbr)) || 'TBD'}`;
  s = s
    .replace(/Round of 32/i, 'R32')
    .replace(/Round of 16/i, 'R16')
    .replace(/Quarterfinal/i, 'QF')
    .replace(/Semifinal/i, 'SF')
    .replace(/\bRD\s*32\b/i, 'R32 winner')
    .replace(/\bRD\s*16\b/i, 'R16 winner')
    .replace(/Winner/i, 'winner')
    .replace(/Loser/i, 'loser')
    .trim();
  return s || 'TBD';
}

function koTeam(t, opp, e) {
  const real = isRealTeam(t);
  const side = t === e.home ? 'home' : 'away';
  // Prefer ESPN's winner flag (a penalty win is a 1–1 draw, so score compare
  // alone can't pick the winner); fall back to score for older data.
  const isWinner = e.winner
    ? e.winner === side
    : e.state === 'post' && parseInt(t?.score, 10) > parseInt(opp?.score, 10);
  const logo =
    real && t.logo
      ? `<img class="ko-logo" src="${escapeHtml(t.logo)}" alt="" loading="lazy" />`
      : '<span class="ko-logo placeholder"></span>';
  const name = real ? t.abbr || t.short || t.name : prettyPlaceholder(t);
  const pens =
    e.shootout && t && t.shootout != null
      ? `<span class="ko-pens">(${t.shootout})</span>`
      : '';
  const score =
    e.state !== 'pre' && t?.score != null
      ? `<span class="ko-score">${escapeHtml(t.score)}${pens}</span>`
      : '';
  return `<div class="ko-team${isWinner ? ' winner' : ''}${real ? '' : ' tbd'}">${logo}<span class="ko-name">${escapeHtml(name)}</span>${score}</div>`;
}

// One match in the bracket grid (a card, or an empty slot while unscheduled).
function bracketCell(e, num, cellClass = '') {
  const cls = `bkt-cell${cellClass ? ' ' + cellClass : ''}`;
  if (!e) {
    return `<div class="${cls}"><div class="bkt-card empty"><span class="bkt-tbd">Match ${num}</span></div></div>`;
  }
  const live = e.state === 'in';
  const meta = live
    ? `<span class="ko-live">● ${escapeHtml(e.detail || 'LIVE')}</span>`
    : e.state === 'post'
    ? `FT${e.shootout ? ' · pens' : ''}`
    : `${escapeHtml(new Date(e.date).toLocaleDateString([], { month: 'short', day: 'numeric' }))} · ${escapeHtml(formatTime(e.date))}`;
  const tappable = isRealTeam(e.home) || isRealTeam(e.away);
  return `<div class="${cls}">
    <div class="bkt-card ${e.state}${tappable ? ' tappable' : ''}"${tappable ? ` data-event-id="${escapeHtml(e.id)}"` : ''}>
      ${koTeam(e.home, e.away, e)}
      ${koTeam(e.away, e.home, e)}
      <div class="bkt-meta">${meta}</div>
    </div>
  </div>`;
}

function bracketHTML() {
  const ko = knockoutEvents();
  if (!ko.length) {
    return `<p class="empty">The knockout bracket appears once the Round of 32 is scheduled (June 28).</p>`;
  }
  ensureMatchNumbers(); // fills missing numbers from the core API, then re-renders
  const byNum = {};
  for (const e of ko) {
    const n = matchNums[e.id];
    if (!n) continue;
    // On a rare duplicate (ESPN projection artifact) prefer the real/played one.
    const cur = byNum[n];
    if (!cur || ((isRealTeam(e.home) || isRealTeam(e.away) || e.state !== 'pre') &&
                 !(isRealTeam(cur.home) || isRealTeam(cur.away) || cur.state !== 'pre'))) {
      byNum[n] = e;
    }
  }
  if (!Object.keys(byNum).length) {
    return `<p class="empty">Loading bracket…</p>`;
  }
  // Two-sided converging bracket: the left half runs inward (R32→SF→Final) and
  // the right half mirrors it. Each round's first half feeds the left semi, the
  // second half the right semi.
  const L = (arr) => arr.slice(0, arr.length / 2);
  const R = (arr) => arr.slice(arr.length / 2);
  const col = (cls, nums, cellClass) =>
    `<div class="bkt-col ${cls}">${nums.map((n) => bracketCell(byNum[n], n, cellClass)).join('')}</div>`;

  const left =
    col('side-left col-r32', L(BRACKET_ORDER.r32)) +
    col('side-left has-conn col-r16', L(BRACKET_ORDER.r16)) +
    col('side-left has-conn col-qf', L(BRACKET_ORDER.qf)) +
    col('side-left has-conn col-sf', [BRACKET_ORDER.sf[0]]);
  const center = col('col-center', [BRACKET_ORDER.final[0]], 'bkt-final-cell');
  const right =
    col('side-right has-conn col-sf', [BRACKET_ORDER.sf[1]]) +
    col('side-right has-conn col-qf', R(BRACKET_ORDER.qf)) +
    col('side-right has-conn col-r16', R(BRACKET_ORDER.r16)) +
    col('side-right col-r32', R(BRACKET_ORDER.r32));

  const headLabels = [
    'Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals',
    'Final',
    'Semi-finals', 'Quarter-finals', 'Round of 16', 'Round of 32',
  ];
  const headers = headLabels.map((h) => `<div class="bkt-head">${escapeHtml(h)}</div>`).join('');
  const third = byNum[THIRD_PLACE_MATCH];
  return `
    <div class="bkt-scroll">
      <div class="bkt-headers">${headers}</div>
      <div class="bkt">${left}${center}${right}</div>
    </div>
    ${third
      ? `<div class="bkt-third"><h3 class="bkt-third-title">🥉 Third place</h3><div class="bkt-third-card">${bracketCell(third, THIRD_PLACE_MATCH)}</div></div>`
      : ''}
    <p class="groups-legend">Swipe across — the bracket runs inward to the final.</p>`;
}

function renderBracketView() {
  matchesEl.innerHTML = bracketHTML();
}

// --- Predictions game -------------------------------------------------------

const PREDICTIONS_KEY = 'wc2026.predictions.v1';
// Superior Player of the Match prediction. ESPN exposes no official award, so
// the "actual" SPOTM is derived from the match timeline (goals weighted, plus
// assists) in superiorPlayer(). Predicted via a simple dropdown; +3 if called.
const SHOW_SPOTM = true;

function loadPredictions() {
  try {
    return JSON.parse(localStorage.getItem(PREDICTIONS_KEY)) || {};
  } catch {
    return {};
  }
}
let predictions = loadPredictions();
// In-progress predictions the user is still editing. NOT persisted and NOT
// counted anywhere — a prediction only becomes "made" (locked, scored, and
// odds-revealing) once the user taps Save, which moves it into `predictions`.
let draftPredictions = {};

// A *committed* (saved + locked) prediction. This is the only kind that counts.
function getPrediction(eventId) {
  const p = predictions[eventId];
  return p && Number.isFinite(p.h) && Number.isFinite(p.a) ? p : null;
}

function getDraft(eventId) {
  return draftPredictions[eventId] || { h: 0, a: 0 };
}

function savePredictions() {
  try { localStorage.setItem(PREDICTIONS_KEY, JSON.stringify(predictions)); } catch {}
}

// Score points: 3 exact, 1 correct outcome, 0 otherwise. Works for live
// (provisional, based on current score) and post (final). null if no score
// available yet or no prediction.
function scorePoints(e) {
  const p = getPrediction(e.id);
  if (!p || e.state === 'pre') return null;
  const h = parseInt(e.home?.score, 10);
  const a = parseInt(e.away?.score, 10);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (p.h === h && p.a === a) return 3;
  if (Math.sign(p.h - p.a) === Math.sign(h - a)) return 1;
  return 0;
}

function lastNameKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.''`]/g, '')
    .trim()
    .split(/\s+/)
    .pop();
}

// +3 if the predicted player IS the match's Superior Player of the Match (our
// derived standout). 0 if resolved-and-wrong, null if not resolved yet.
function motmBonus(e) {
  const p = getPrediction(e.id);
  if (!p?.motm) return null;
  const sp = superiorPlayer(e);
  if (sp) {
    const hit = p.motm.abbr === sp.abbr && lastNameKey(p.motm.name) === lastNameKey(sp.name);
    return hit ? 3 : 0;
  }
  // No standout derivable. If the match is over AND its detail is loaded (a
  // genuine goalless game), the pick can't be right → 0; else still pending.
  const entry = state.stats[e.id];
  const loaded = entry && entry.timeline && !entry.loading && !entry.error;
  return e.state === 'post' && loaded ? 0 : null;
}

// Combined running points for the card chip (live = provisional).
function predictionTotal(e) {
  if (e.state === 'pre') return null;
  const sp = scorePoints(e);
  if (sp == null) return null;
  return sp + (SHOW_SPOTM ? motmBonus(e) || 0 : 0);
}

// Final, locked points — only counts finished matches toward the header total.
function finalPoints(e) {
  if (e.state !== 'post') return null;
  const sp = scorePoints(e);
  if (sp == null) return null;
  return sp + (SHOW_SPOTM ? motmBonus(e) || 0 : 0);
}

function totalPredictionPoints() {
  let total = 0;
  for (const e of state.events) {
    const pts = finalPoints(e);
    if (pts != null) total += pts;
  }
  return total;
}

// Make sure finished matches we predicted have their timeline loaded so the
// MOTM bonus can resolve.
function resolvePredictionStats() {
  for (const e of state.events) {
    // Any finished match we predicted: load its timeline so the MOTM bonus
    // resolves AND we can show who the match's standout (top scorer) was.
    if (e.state === 'post' && getPrediction(e.id) && !state.stats[e.id]) {
      ensureStats(e.id);
    }
  }
}

// ESPN's feed has no official "Superior Player of the Match" award, so we
// derive the match's standout from the timeline: goals (weighted) plus
// assists. Own goals don't count. Returns null for a goalless game (can't be
// determined from the data).
function superiorPlayer(e) {
  const entry = state.stats[e.id];
  if (!entry || !entry.timeline) return null;
  const tally = new Map(); // lastName|abbr -> { name, abbr, goals, assists, first }
  const bump = (name, abbr, field, clock) => {
    if (!name || name === '?') return;
    const key = `${lastNameKey(name)}|${abbr || ''}`;
    const cur = tally.get(key) || { name, abbr, goals: 0, assists: 0, first: Infinity };
    cur[field] += 1;
    if (field === 'goals' && clock != null) cur.first = Math.min(cur.first, clock);
    tally.set(key, cur);
  };
  for (const t of entry.timeline) {
    if (t.kind !== 'goal' && t.kind !== 'penalty-goal') continue;
    const side = timelineSide(t, e);
    const abbr = side === 'home' ? e.home?.abbr : e.away?.abbr;
    bump(t.player, abbr, 'goals', t.clockValue);
    if (t.assist) bump(t.assist, abbr, 'assists');
  }
  if (!tally.size) return null;
  return [...tally.values()]
    .map((v) => ({ ...v, score: v.goals * 2 + v.assists }))
    .sort((a, b) => b.score - a.score || b.goals - a.goals || a.first - b.first)[0];
}

const POS_RANK = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
function posShort(position) {
  if (/goalkeeper/i.test(position)) return 'GK';
  if (/defender/i.test(position)) return 'DEF';
  if (/forward/i.test(position)) return 'FWD';
  return 'MID';
}

function squadList(abbr) {
  const gName = ABBR_TO_GUARDIAN[abbr];
  const squad = photoDb && gName ? photoDb[gName] : null;
  if (!squad) return [];
  return Object.entries(squad)
    .map(([num, p]) => ({
      num: parseInt(num, 10),
      name: p.name,
      photo: p.photo,
      position: p.position || '',
      pos: posShort(p.position || ''),
    }))
    // Order like a team sheet: GK → DEF → MID → FWD, then by shirt number.
    .sort((a, b) => POS_RANK[a.pos] - POS_RANK[b.pos] || a.num - b.num);
}

// What the closed dropdown shows: the chosen player's photo + name, or a hint.
function motmTriggerContent(motm) {
  if (!motm) return `<span class="motm-dd-ph">Pick a player (optional)</span>`;
  const photo = photoFor(motm.abbr, motm.jersey);
  const img = photo
    ? `<img class="motm-dd-photo" src="${escapeHtml(photo)}" alt="" />`
    : `<span class="motm-dd-photo placeholder">${escapeHtml(String(motm.jersey || ''))}</span>`;
  return `<span class="motm-dd-sel">${img}<span class="motm-dd-selname">${escapeHtml(motm.name)}</span></span>`;
}

// One team's players as rich rows (photo + name + position + number) for the
// custom MOTM dropdown — a native <select> can't show photos.
function motmGroup(team, squad, motm) {
  if (!team || !squad.length) return '';
  const label = team.short || team.name || team.abbr || '';
  const rows = squad
    .map((pl) => {
      const sel = motm && motm.abbr === team.abbr && String(motm.jersey) === String(pl.num);
      const photo = pl.photo
        ? `<img class="motm-opt-photo" src="${escapeHtml(pl.photo)}" alt="" loading="lazy" />`
        : `<span class="motm-opt-photo placeholder">${pl.num}</span>`;
      const pos = pl.pos ? `<span class="motm-opt-pos">${escapeHtml(pl.pos)}</span>` : '';
      return `<button type="button" class="motm-dd-opt${sel ? ' selected' : ''}" role="option" aria-selected="${sel}" data-abbr="${escapeHtml(team.abbr)}" data-jersey="${pl.num}" data-name="${escapeHtml(pl.name)}">
        ${photo}
        <span class="motm-opt-name">${escapeHtml(pl.name)}</span>
        <span class="motm-opt-meta">${pos}<span class="motm-opt-num">#${pl.num}</span></span>
      </button>`;
    })
    .join('');
  return `<div class="motm-dd-grouplabel">${escapeHtml(label)}</div>${rows}`;
}

function renderPredictionPanel(e) {
  const committed = getPrediction(e.id);
  // LOCKED view — a saved prediction can't be changed.
  if (committed) {
    const motmName = committed.motm ? committed.motm.name.split(' ').pop() : '';
    return `
      <div class="stats pred-panel">
        <h3 class="stats-section-title">🎯 Your prediction</h3>
        <div class="pred-locked">
          <span class="pred-locked-score">${escapeHtml(e.home?.short || e.home?.abbr || '?')} <strong>${committed.h}–${committed.a}</strong> ${escapeHtml(e.away?.short || e.away?.abbr || '?')}</span>
          ${SHOW_SPOTM && committed.motm ? `<span class="pred-locked-motm">⭐ ${escapeHtml(motmName)}</span>` : ''}
          <span class="pred-lock-badge">${LOCK_ICON} Locked</span>
        </div>
        <p class="pred-hint">Scores automatically at full time.</p>
      </div>`;
  }
  // DRAFT editor — adjust freely, then Save to lock it in.
  const p = getDraft(e.id);
  const side = (team, key) => `
    <div class="pred-side">
      <span class="pred-team">${escapeHtml(team?.short || team?.abbr || '?')}</span>
      <div class="pred-ctrl">
        <button type="button" class="pred-step" data-ev="${escapeHtml(e.id)}" data-side="${key}" data-delta="-1" aria-label="decrease">−</button>
        <span class="pred-val">${p[key] || 0}</span>
        <button type="button" class="pred-step" data-ev="${escapeHtml(e.id)}" data-side="${key}" data-delta="1" aria-label="increase">+</button>
      </div>
    </div>`;
  const motm = p.motm;
  const homeSquad = squadList(e.home?.abbr);
  const awaySquad = squadList(e.away?.abbr);
  const motmSection =
    SHOW_SPOTM && (homeSquad.length || awaySquad.length)
      ? `
    <div class="pred-motm">
      <span class="pred-motm-label">⭐ Superior Player of the Match <span class="motm-bonus">+3</span></span>
      <div class="motm-dd" data-ev="${escapeHtml(e.id)}">
        <button type="button" class="motm-dd-trigger" aria-haspopup="listbox" aria-expanded="false">
          ${motmTriggerContent(motm)}
          <span class="motm-dd-caret" aria-hidden="true">▾</span>
        </button>
        <div class="motm-dd-menu" role="listbox" hidden>
          <button type="button" class="motm-dd-opt motm-dd-clear" data-clear="1">No pick</button>
          ${motmGroup(e.home, homeSquad, motm)}
          ${motmGroup(e.away, awaySquad, motm)}
        </div>
      </div>
    </div>`
      : '';
  return `
    <div class="stats pred-panel">
      <h3 class="stats-section-title">🎯 Your prediction</h3>
      <div class="pred-row">
        ${side(e.home, 'h')}
        <span class="pred-x">:</span>
        ${side(e.away, 'a')}
      </div>
      ${motmSection}
      <button type="button" class="pred-save" data-ev="${escapeHtml(e.id)}">Save prediction</button>
      <p class="pred-hint">Predictions are final once saved.<br>Saving reveals the win probability.</p>
    </div>`;
}

// Read-only prediction status shown inside live/finished match stats so the
// user can always find their call once the game is underway.
function renderPredictionStatus(e) {
  const p = getPrediction(e.id);
  if (!p) return '';
  const total = predictionTotal(e);
  const motmName = p.motm ? p.motm.name.split(' ').pop() : '';
  const motmState =
    SHOW_SPOTM && p.motm
      ? motmBonus(e) == null
        ? `· SPOTM ${escapeHtml(motmName)}`
        : motmBonus(e) > 0
        ? `· SPOTM ${escapeHtml(motmName)} ✓`
        : `· SPOTM ${escapeHtml(motmName)} ✗`
      : '';
  const label = e.state === 'post' ? 'Final' : 'So far';
  const star = SHOW_SPOTM && e.state === 'post' ? superiorPlayer(e) : null;
  const starHtml = star
    ? `<div class="pred-status-motm">⭐ Superior Player: <strong>${escapeHtml(star.name)}</strong>${star.abbr ? ` (${escapeHtml(star.abbr)})` : ''}</div>`
    : '';
  return `
    <div class="pred-status">
      <span class="pred-status-call">🎯 You called <strong>${p.h}–${p.a}</strong> ${motmState}</span>
      <span class="pred-status-pts ${total > 0 ? 'won' : 'lost'}">${label}: ${total == null ? '…' : '+' + total} pts</span>
    </div>
    ${starHtml}`;
}

function onPredictionStep(btn) {
  const id = btn.dataset.ev;
  if (getPrediction(id)) return; // already saved → locked, can't change
  const side = btn.dataset.side;
  const delta = parseInt(btn.dataset.delta, 10);
  const cur = { ...getDraft(id) };
  cur.h = cur.h || 0;
  cur.a = cur.a || 0;
  cur[side] = Math.max(0, Math.min(19, (cur[side] || 0) + delta));
  draftPredictions[id] = cur;
  render(); // draft only — nothing persisted yet
}

// A pick from the custom SPOTM dropdown (a row, or the "No pick" clear button).
function onMotmPickDD(opt) {
  const dd = opt.closest('.motm-dd');
  const id = dd && dd.dataset.ev;
  if (!id || getPrediction(id)) return; // locked
  const cur = { ...getDraft(id) };
  cur.h = cur.h || 0;
  cur.a = cur.a || 0;
  if (opt.dataset.clear) {
    delete cur.motm;
  } else {
    cur.motm = {
      abbr: opt.dataset.abbr,
      jersey: parseInt(opt.dataset.jersey, 10),
      name: opt.dataset.name,
    };
  }
  draftPredictions[id] = cur;
  render(); // refresh the trigger + selected row; the menu rebuilds closed
}

function closeMotmMenus(except) {
  document.querySelectorAll('.motm-dd-menu:not([hidden])').forEach((m) => {
    if (m === except) return;
    m.setAttribute('hidden', '');
    const t = m.parentElement && m.parentElement.querySelector('.motm-dd-trigger');
    if (t) t.setAttribute('aria-expanded', 'false');
  });
}

// Commit the draft → permanent, locked prediction. This is what unlocks the
// win probability and what gets scored.
function onPredictionSave(id) {
  if (getPrediction(id)) return; // already saved
  const d = getDraft(id);
  predictions[id] = {
    h: d.h || 0,
    a: d.a || 0,
    ...(d.motm ? { motm: d.motm } : {}),
    locked: true,
  };
  savePredictions();
  delete draftPredictions[id];
  render();
  updatePredictionsChip();
  ensureStats(id); // make sure the odds are loaded so the bar can reveal
}

const predictionsChip = $('#predictions-chip');
const predictionsDialog = $('#predictions-dialog');
const predictionsList = $('#predictions-list');

function updatePredictionsChip() {
  if (!predictionsChip) return;
  const count = Object.keys(predictions).length;
  predictionsChip.hidden = count === 0;
  const ptsEl = $('#predictions-points');
  if (ptsEl) ptsEl.textContent = String(totalPredictionPoints());
}

function renderPredictionsList() {
  if (!predictionsList) return;
  const rows = state.events
    .filter((e) => getPrediction(e.id))
    .map((e) => {
      const p = getPrediction(e.id);
      const pts = finalPoints(e);
      const isLive = e.state === 'in';
      const actual =
        e.state === 'post'
          ? `Final ${e.home?.score}–${e.away?.score}`
          : isLive
          ? `LIVE ${e.home?.score}–${e.away?.score}`
          : formatDayLabel(localDayKey(e.date));
      const ptsHtml =
        pts == null
          ? '<span class="predl-pts pending">·</span>'
          : `<span class="predl-pts ${pts > 0 ? 'won' : 'lost'}">${pts > 0 ? '+' + pts : '0'}</span>`;
      const motmHtml = SHOW_SPOTM && p.motm
        ? `<span class="predl-motm">⭐ ${escapeHtml(p.motm.name.split(' ').pop())}</span>`
        : '';
      const flag = (t) =>
        t?.logo
          ? `<img class="predl-flag" src="${escapeHtml(t.logo)}" alt="" loading="lazy" />`
          : '<span class="predl-flag placeholder"></span>';
      // Actual Superior Player of the Match once the match is over.
      const star = SHOW_SPOTM && e.state === 'post' ? superiorPlayer(e) : null;
      const correct = p.motm && star && p.motm.abbr === star.abbr && lastNameKey(p.motm.name) === lastNameKey(star.name);
      const starHtml = star
        ? `<div class="predl-star">⭐ Superior Player: <strong>${escapeHtml(star.name)}</strong>${star.abbr ? ` (${escapeHtml(star.abbr)})` : ''}${correct ? ' <span class="predl-star-hit">✓ your pick</span>' : ''}</div>`
        : '';
      return `
        <div class="predl-row">
          <div class="predl-head">
            <span class="predl-match">
              ${flag(e.home)}<span class="predl-abbr">${escapeHtml(e.home?.abbr || '?')}</span>
              <span class="predl-v">v</span>
              ${flag(e.away)}<span class="predl-abbr">${escapeHtml(e.away?.abbr || '?')}</span>
            </span>
            ${ptsHtml}
          </div>
          <div class="predl-sub">
            <span class="predl-pred">🎯 <strong>${p.h}–${p.a}</strong>${motmHtml}</span>
            <span class="predl-actual${isLive ? ' live' : ''}">${escapeHtml(actual)}</span>
          </div>
          ${starHtml}
        </div>`;
    })
    .join('');
  const summaryEl = $('#predictions-summary');
  const made = state.events.filter((e) => getPrediction(e.id));
  const settled = made.filter((e) => finalPoints(e) != null).length;
  if (summaryEl) {
    summaryEl.innerHTML = made.length
      ? `<div class="pred-summary-total"><span class="pred-summary-num">${totalPredictionPoints()}</span><span class="pred-summary-unit">pts</span></div>
         <div class="pred-summary-meta">${made.length} prediction${made.length === 1 ? '' : 's'}${settled ? ` · ${settled} scored` : ''}</div>
         <div class="pred-scoring">
           <span class="pred-scoring-head">How points work</span>
           <div class="pred-scoring-row"><span>Exact score</span><b>3 pts</b></div>
           <div class="pred-scoring-row"><span>Correct result (win / draw / loss)</span><b>1 pt</b></div>
           ${SHOW_SPOTM ? '<div class="pred-scoring-row"><span>Superior Player of the Match</span><b>3 pts</b></div>' : ''}
         </div>`
      : '';
  }
  predictionsList.innerHTML =
    rows || '<p class="empty">No predictions yet — open an upcoming match, set a score and save it.</p>';
}

predictionsChip?.addEventListener('click', () => {
  resolvePredictionStats();
  renderPredictionsList();
  resetBackupUI();
  if (typeof predictionsDialog.showModal === 'function') predictionsDialog.showModal();
});
$('#predictions-close')?.addEventListener('click', () => predictionsDialog.close());
// Click on the backdrop (outside the card) closes it. The dialog content is
// wrapped in .prefs-body, so any click landing on the dialog element itself
// is the backdrop.
predictionsDialog?.addEventListener('click', (e) => {
  if (e.target === predictionsDialog) predictionsDialog.close();
});

// --- Predictions backup / restore ------------------------------------------
// Predictions live in localStorage, which mobile browsers can wipe out from
// under us: iOS Safari (and Home-Screen apps) evict all script-writable
// storage after ~7 idle days, and Chrome evicts under disk pressure unless
// the origin has been granted *persistent* storage. Two defences:
//   1) ask the browser for persistent storage so it stops evicting us, and
//   2) let the user save a backup file — it lives in Downloads, outside the
//      storage the browser clears, so it survives an eviction OR a reinstall.

async function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;
    const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    if (!already) await navigator.storage.persist();
  } catch {}
}

function backupPayload() {
  return JSON.stringify(
    {
      app: 'world-cup-2026',
      kind: 'predictions-backup',
      version: 1,
      savedAt: new Date().toISOString(),
      predictions,
    },
    null,
    2
  );
}

function backupFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `world-cup-predictions-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
    return true;
  } catch {
    return false;
  }
}

const backupStatus = $('#pred-backup-status');
const backupCode = $('#pred-backup-code');
const backupApply = document.querySelector('.pred-backup-apply');
const importFileInput = $('#pred-import-file');

const BACKUP_HINT_DEFAULT =
  'Save a backup file so your predictions survive a reinstall or a browser storage cleanup.';

function setBackupStatus(msg) {
  if (backupStatus) backupStatus.textContent = msg;
}

// Reset the backup/restore controls to their resting state — called each time
// the popup opens so a stale error or a previous backup code never lingers.
function resetBackupUI() {
  if (backupCode) {
    backupCode.hidden = true;
    backupCode.value = '';
    backupCode.readOnly = true;
  }
  if (backupApply) backupApply.hidden = true;
  setBackupStatus(BACKUP_HINT_DEFAULT);
}

function exportPredictions() {
  const count = Object.keys(predictions).length;
  if (!count) {
    setBackupStatus('No predictions to back up yet — make one first.');
    return;
  }
  const text = backupPayload();
  const downloaded = downloadText(backupFilename(), text);
  // Always surface the code too: on iOS standalone the file download can be
  // blocked, so a copy-pasteable code is a guaranteed fallback.
  if (backupCode) {
    backupCode.value = text;
    backupCode.readOnly = true;
    backupCode.hidden = false;
  }
  if (backupApply) backupApply.hidden = true;
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => {},
      () => {}
    );
    copied = true;
  }
  setBackupStatus(
    `${count} prediction${count === 1 ? '' : 's'} backed up.` +
      (downloaded ? ' Saved to your downloads.' : '') +
      (copied
        ? ' Also copied — paste it somewhere safe (Notes, email).'
        : ' Long-press the text below to copy it somewhere safe.')
  );
}

// Accept either the wrapped backup ({ predictions: {...} }) or a bare
// { eventId: {h,a} } map. Returns a cleaned, validated map or null.
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const map =
    data && data.predictions && typeof data.predictions === 'object'
      ? data.predictions
      : data && typeof data === 'object'
      ? data
      : null;
  if (!map) return null;
  const clean = {};
  for (const [id, p] of Object.entries(map)) {
    if (p && Number.isFinite(p.h) && Number.isFinite(p.a)) {
      clean[id] = {
        h: p.h,
        a: p.a,
        ...(p.motm ? { motm: p.motm } : {}),
        locked: true,
      };
    }
  }
  return Object.keys(clean).length ? clean : null;
}

function applyRestore(text) {
  const restored = parseBackup(text);
  if (!restored) {
    setBackupStatus('That doesn’t look like a valid backup. Pick the .json file you saved.');
    return;
  }
  const before = Object.keys(predictions).length;
  // Restored entries win; any newer local predictions not in the backup are
  // kept, so restoring an older backup never destroys a more recent pick.
  predictions = { ...predictions, ...restored };
  savePredictions();
  const added = Object.keys(predictions).length - before;
  resolvePredictionStats();
  renderPredictionsList();
  render();
  updatePredictionsChip();
  if (backupCode) {
    backupCode.hidden = true;
    backupCode.value = '';
  }
  if (backupApply) backupApply.hidden = true;
  const n = Object.keys(restored).length;
  setBackupStatus(
    `Restored ${n} prediction${n === 1 ? '' : 's'}${added > 0 ? ` (${added} new)` : ''}.`
  );
}

$('#pred-export')?.addEventListener('click', exportPredictions);
$('#pred-import')?.addEventListener('click', () => {
  // Reveal an editable paste box AND open the file picker — whichever the
  // user has handy works.
  if (backupCode) {
    backupCode.value = '';
    backupCode.readOnly = false;
    backupCode.hidden = false;
    backupCode.placeholder = 'Paste your backup code here, or choose the .json file…';
  }
  if (backupApply) backupApply.hidden = false;
  setBackupStatus('Choose your backup file, or paste your backup code below.');
  importFileInput?.click();
});
$('#pred-apply-code')?.addEventListener('click', () => {
  if (backupCode && backupCode.value.trim()) applyRestore(backupCode.value);
  else setBackupStatus('Paste your backup code first, or choose the .json file.');
});
importFileInput?.addEventListener('change', async () => {
  const file = importFileInput.files && importFileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    applyRestore(text);
  } catch {
    setBackupStatus('Couldn’t read that file. Try pasting the backup code instead.');
  }
  importFileInput.value = '';
});

// --- Team sheet -------------------------------------------------------------

const teamDialog = $('#team-dialog');
const teamDialogClose = $('#team-dialog-close');

function teamFromEvents(abbr) {
  for (const e of state.events) {
    if (e.home?.abbr === abbr) return e.home;
    if (e.away?.abbr === abbr) return e.away;
  }
  return null;
}

function standingFor(abbr) {
  for (const g of state.standings?.groups || []) {
    const entry = (g.entries || []).find((t) => t.abbr === abbr);
    if (entry) return { group: g.name, entry };
  }
  return null;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function openTeamDialog(abbr) {
  if (!teamDialog) return;
  await ensurePhotoDb(); // squad photos must be ready before we build the body
  const team = teamFromEvents(abbr);
  const guardianName = ABBR_TO_GUARDIAN[abbr] || abbr;
  // Nothing real to show (e.g. a knockout placeholder) — don't open an empty shell.
  if (!team && !photoDb?.[guardianName]) return;
  const standing = standingFor(abbr);
  const color = safeHex(team?.color);

  const hero = $('#team-dialog-hero');
  if (hero) {
    hero.style.background = color
      ? `linear-gradient(150deg, ${color}cc 0%, #07241b 80%)`
      : '';
  }
  $('#team-dialog-logo').src = team?.logo || '';
  $('#team-dialog-name').textContent = team?.name || guardianName;
  const subBits = [];
  if (standing) {
    subBits.push(standing.group);
    if (standing.entry.rank) subBits.push(`${ordinal(standing.entry.rank)} · ${standing.entry.pts} pts`);
  }
  $('#team-dialog-sub').textContent = subBits.join(' · ') || 'World Cup 2026';

  // Fixtures involving this team.
  const fixtures = state.events
    .filter((e) => e.home?.abbr === abbr || e.away?.abbr === abbr)
    .map((e) => {
      const isHome = e.home?.abbr === abbr;
      const opp = isHome ? e.away : e.home;
      const mid =
        e.state === 'pre'
          ? `<span class="tf-time">${formatTime(e.date)}</span>`
          : `<span class="tf-score${e.state === 'in' ? ' live' : ''}">${escapeHtml(e.home?.score)}–${escapeHtml(e.away?.score)}</span>`;
      const day = new Date(e.date).toLocaleDateString([], { month: 'short', day: 'numeric' });
      const res = resultLetter(e, abbr);
      // The opponent is tappable → jump straight to their team sheet.
      const oppClickable = opp?.abbr ? ` data-team-abbr="${escapeHtml(opp.abbr)}" role="button" tabindex="0"` : '';
      return `
        <div class="tf-row">
          <span class="tf-day">${escapeHtml(day)}</span>
          <span class="tf-ha">${isHome ? 'vs' : '@'}</span>
          <span class="tf-team"${oppClickable}>
            ${opp?.logo ? `<img class="tf-logo" src="${escapeHtml(opp.logo)}" alt="" loading="lazy" />` : ''}
            <span class="tf-opp">${escapeHtml(opp?.short || opp?.name || 'TBD')}</span>
          </span>
          ${mid}
          ${res}
        </div>`;
    })
    .join('');

  // Squad grid from the Guardian photo DB (offline, all 26 players).
  const squad = photoDb?.[guardianName] || {};
  const players = Object.entries(squad)
    .map(([num, p]) => ({ num: parseInt(num, 10), ...p }))
    .sort((a, b) => a.num - b.num);
  const squadHtml = players.length
    ? `<div class="squad-grid">
        ${players
          .map(
            (p) => `
          <div class="squad-player" ${p.photo ? `data-player-photo="${escapeHtml(p.photo)}" data-player-name="${escapeHtml(p.name)}" data-player-team="${escapeHtml(guardianName)}" data-player-pos="${escapeHtml(p.position)}" data-player-jersey="${p.num}" role="button" tabindex="0"` : ''}>
            ${p.photo ? `<img class="squad-photo" src="${escapeHtml(p.photo)}" alt="" loading="lazy" />` : `<span class="squad-photo placeholder">${p.num}</span>`}
            <span class="squad-num">${p.num}</span>
            <span class="squad-name">${escapeHtml(p.name)}</span>
          </div>`
          )
          .join('')}
      </div>`
    : '<p class="empty">Squad unavailable.</p>';

  $('#team-dialog-body').innerHTML = `
    <h3 class="stats-section-title">Fixtures</h3>
    <div class="tf-list">${fixtures || '<p class="empty">No fixtures.</p>'}</div>
    <h3 class="stats-section-title">Squad</h3>
    ${squadHtml}
  `;
  $('#team-dialog-body').scrollTop = 0;
  if (teamDialog.open) teamDialog.close();
  if (typeof teamDialog.showModal === 'function') teamDialog.showModal();
}

function resultLetter(e, abbr) {
  if (e.state !== 'post') return '';
  const h = parseInt(e.home?.score, 10);
  const a = parseInt(e.away?.score, 10);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return '';
  const isHome = e.home?.abbr === abbr;
  const mine = isHome ? h : a;
  const theirs = isHome ? a : h;
  const letter = mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
  return `<span class="tf-res ${letter.toLowerCase()}">${letter}</span>`;
}

teamDialogClose?.addEventListener('click', () => teamDialog.close());
teamDialog?.addEventListener('click', (e) => {
  // Player chip inside the squad grid → player overlay on top.
  const chip = e.target.closest('[data-player-photo]');
  if (chip) {
    openPlayerDialog(chip.dataset);
    return;
  }
  // Opponent in the fixtures list → swap this dialog to that team.
  const teamLink = e.target.closest('[data-team-abbr]');
  if (teamLink && teamLink.dataset.teamAbbr) {
    e.stopPropagation();
    openTeamDialog(teamLink.dataset.teamAbbr);
    return;
  }
  const rect = teamDialog.getBoundingClientRect();
  const inside =
    e.clientX >= rect.left && e.clientX <= rect.right &&
    e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!inside) teamDialog.close();
});

function renderStats(e) {
  const predStatus = renderPredictionStatus(e);
  const entry = state.stats[e.id];
  if (!entry) {
    return `<div class="stats">${predStatus}<div class="stats-loading-inline">Loading match detail…</div></div>`;
  }
  if (entry.error) {
    return `<div class="stats">${predStatus}<div class="stats empty">${escapeHtml(entry.error)}</div></div>`;
  }
  const hasRows = entry.rows && entry.rows.length;
  const hasTimeline = entry.timeline && entry.timeline.length;
  const hasLineups = entry.lineups && entry.lineups.home;
  if (!hasRows && !hasTimeline && !hasLineups) {
    return `<div class="stats">${predStatus}<div class="stats empty">No stats available yet.</div></div>`;
  }
  return `
    <div class="stats">
      ${predStatus}
      ${hasTimeline ? renderTimeline(e, entry.timeline, entry.lineups) : ''}
      ${e.shootout ? renderShootout(e) : ''}
      ${hasRows ? renderStatsTable(e, entry.rows) : ''}
      ${hasLineups ? renderLineups(e, entry.lineups) : ''}
      ${renderMatchInfo(entry.info)}
    </div>
  `;
}

// Penalty shootout result + who took each kick (only when a knockout draw was
// decided on penalties). Data comes from the event itself (normalize()).
function renderShootout(e) {
  const s = e.shootout;
  if (!s) return '';
  const winSide = s.home > s.away ? 'home' : s.away > s.home ? 'away' : null;
  const winName = winSide
    ? (winSide === 'home' ? e.home : e.away)?.short ||
      (winSide === 'home' ? e.home : e.away)?.name || ''
    : '';
  const taker = (t) => {
    const team = t.side === 'home' ? e.home : e.away;
    const photo = photoFor(team?.abbr, '');
    return `<div class="pk-taker ${t.scored ? 'scored' : 'missed'}">
      <span class="pk-mark">${t.scored ? '✓' : '✗'}</span>
      <span class="pk-name">${escapeHtml(t.player || '—')}</span>
      <span class="pk-abbr">${escapeHtml(team?.abbr || '')}</span>
    </div>`;
  };
  const takers = (s.takers || []).length
    ? `<div class="pk-takers">${s.takers.map(taker).join('')}</div>`
    : '';
  return `
    <div class="stats-section pk-section">
      <h3 class="stats-section-title">Penalty shootout</h3>
      <div class="pk-result">
        <span class="pk-score">${escapeHtml(e.home?.short || e.home?.abbr || '')} <strong>${s.home}–${s.away}</strong> ${escapeHtml(e.away?.short || e.away?.abbr || '')}</span>
        ${winName ? `<span class="pk-win">🏆 ${escapeHtml(winName)} advance</span>` : ''}
      </div>
      ${takers}
    </div>`;
}

function renderMatchInfo(info) {
  if (!info || (!info.attendance && !info.referee)) return '';
  const bits = [];
  if (info.attendance) {
    bits.push(`<span class="mi-item">👥 ${Number(info.attendance).toLocaleString()}</span>`);
  }
  if (info.referee) {
    bits.push(`<span class="mi-item">🏳️ Referee: ${escapeHtml(info.referee)}</span>`);
  }
  return `<div class="match-info">${bits.join('<span class="mi-sep">·</span>')}</div>`;
}

const TIMELINE_GLYPH = {
  'goal': '⚽',
  'own-goal': '⚽',
  'penalty-goal': '⚽',
  'penalty-miss': '🚫',
  'yellow-card': '<span class="card yellow"></span>',
  'red-card': '<span class="card red"></span>',
  'sub': '<span class="sub-glyph">⇄</span>',
};

// A small pill flagging penalties / own goals, kept OUTSIDE the player name so
// it's always visible even when the name wraps.
const TIMELINE_TAG = {
  'penalty-goal': '<span class="tl-tag pen">PEN</span>',
  'own-goal': '<span class="tl-tag og">OG</span>',
  'penalty-miss': '<span class="tl-tag miss">PEN MISS</span>',
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
    const side = timelineSide(t, e); // the team the goal counts FOR
    const ownGoal = t.kind === 'own-goal';
    // An own goal is credited to the beneficiary while the scorer plays for the
    // other team, and ESPN isn't consistent about which side it tags — so look
    // the player up in EITHER roster (also covers subs) and take the team where
    // he's found, otherwise the photo comes back blank ("?").
    const preferSide = ownGoal ? (side === 'home' ? 'away' : 'home') : side;
    let rosterPlayer = findRosterPlayer(lineups, preferSide, t.athleteId, t.player);
    let playerAbbr = preferSide === 'home' ? homeAbbr : awayAbbr;
    if (!rosterPlayer) {
      const other = preferSide === 'home' ? 'away' : 'home';
      const rp2 = findRosterPlayer(lineups, other, t.athleteId, t.player);
      if (rp2) { rosterPlayer = rp2; playerAbbr = other === 'home' ? homeAbbr : awayAbbr; }
    }
    const badge = playerBadge(rosterPlayer, playerAbbr, t.player);
    const glyph = TIMELINE_GLYPH[t.kind] || '';
    const tag = TIMELINE_TAG[t.kind] || '';
    const subPrefix = t.kind === 'sub' ? 'for' : 'assist';
    // ESPN lists a second participant on own goals that isn't really an assist.
    const assistHtml = t.assist && !ownGoal
      ? `<span class="tl-assist">${subPrefix} ${escapeHtml(t.assist)}</span>`
      : '';
    const minute = escapeHtml(t.minute || "—'");
    const isGoal = /goal$/.test(t.kind);
    const rowCls = `tl-row ${side} ${isGoal ? 'goal' : ''}${t.kind === 'sub' ? ' sub' : ''}`;
    const nameInner = `<span class="tl-nm">${escapeHtml(t.player)}</span>`;
    // Only the small glyph (ball / card) sits next to the minute pill. The
    // PEN / OG / PEN-MISS tag goes on its OWN line under the name so a wide
    // tag never squeezes the name into a one-letter-per-line column.
    const glyphHtml = `<span class="tl-marks"><span class="tl-glyph">${glyph}</span></span>`;
    const tagLine = tag ? `<div class="tl-tagline">${tag}</div>` : '';
    if (side === 'home') {
      return `
        <li class="${rowCls}">
          <div class="tl-half">
            ${badge}
            <div class="tl-text">
              <div class="tl-name">${nameInner}</div>
              ${tagLine}
              ${assistHtml}
            </div>
            ${glyphHtml}
            <span class="tl-dots" aria-hidden="true"></span>
            <span class="tl-minute">${minute}</span>
          </div>
        </li>`;
    }
    return `
      <li class="${rowCls}">
        <div class="tl-half">
          <span class="tl-minute">${minute}</span>
          <span class="tl-dots" aria-hidden="true"></span>
          ${glyphHtml}
          <div class="tl-text">
            <div class="tl-name">${nameInner}</div>
            ${tagLine}
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

function parseStatNum(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function renderStatsTable(e, rows) {
  const homeName = e.home?.short || e.home?.name || 'Home';
  const awayName = e.away?.short || e.away?.name || 'Away';
  // Bars are tinted with each team's colour. Fall back to a readable tint
  // when a kit colour is missing, and if both teams share a colour (e.g. two
  // red kits) lighten the away side so the two bars stay distinguishable.
  const rawH = safeHex(e.home?.color);
  const rawA = safeHex(e.away?.color);
  const hc = rawH || 'var(--accent)';
  let ac = rawA || '#5a8bd6';
  if (rawH && rawA && colorsClash(rawH, rawA)) {
    ac = `color-mix(in srgb, ${rawA} 42%, #ffffff)`;
  }
  const items = rows
    .map((row) => {
      const h = parseStatNum(row.home);
      const a = parseStatNum(row.away);
      const total = h + a;
      const hPct = total > 0 ? (h / total) * 100 : 50;
      const aPct = total > 0 ? (a / total) * 100 : 50;
      const winSide = h === a ? 'tied' : h > a ? 'home' : 'away';
      return `
        <div class="stat-row ${winSide}" style="--hc:${hc};--ac:${ac}">
          <div class="stat-label">${escapeHtml(row.label)}</div>
          <div class="stat-values">
            <span class="stat-val home">${escapeHtml(row.home)}</span>
            <div class="stat-bar" aria-hidden="true">
              <div class="stat-bar-fill home" style="width:${hPct}%"></div>
              <div class="stat-bar-fill away" style="width:${aPct}%"></div>
            </div>
            <span class="stat-val away">${escapeHtml(row.away)}</span>
          </div>
        </div>`;
    })
    .join('');
  return `
    <div class="stats-section">
      <h3 class="stats-section-title">Statistics</h3>
      <div class="stats-teams">
        <span class="stats-team-name home">${escapeHtml(homeName)}</span>
        <span class="stats-team-name away">${escapeHtml(awayName)}</span>
      </div>
      <div class="stat-rows">${items}</div>
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

// Strip the directional suffix and return the position base.
function positionBase(pos) {
  return (pos || '').toUpperCase().replace(/-[LCR]$/, '');
}
// Classify into broad group for fallback bucketing.
const DEF_BASE = new Set(['D', 'CB', 'CD', 'RB', 'LB', 'WB', 'RWB', 'LWB']);
const FWD_BASE = new Set(['F', 'ST', 'CF', 'RF', 'LF', 'RW', 'LW']);
function positionGroup(pos) {
  const base = positionBase(pos);
  if (base === 'G' || base === 'GK') return 'GK';
  if (DEF_BASE.has(base)) return 'DEF';
  if (FWD_BASE.has(base)) return 'FWD';
  return 'MID';
}
// Defensive-to-attacking rank for slotting by formation digits.
const POSITION_RANK = {
  G: 0, GK: 0,
  D: 10, CB: 10, CD: 10,
  RB: 11, LB: 11,
  WB: 15, RWB: 15, LWB: 15,
  DM: 20, CDM: 20,
  M: 30, CM: 30,
  LM: 35, RM: 35,
  AM: 40, CAM: 40,
  LW: 50, RW: 50,
  F: 60, ST: 60, CF: 60, RF: 60, LF: 60,
};
function positionRank(pos) {
  const base = positionBase(pos);
  return POSITION_RANK[base] ?? 30; // default to central midfielder
}
function dirRank(p) {
  const pos = (p.pos || '').toUpperCase();
  if (/-L$|^L[^W]?|LW|LB|LM|LF|LWB/.test(pos)) return 0;
  if (/-R$|^R[^W]?|RW|RB|RM|RF|RWB/.test(pos)) return 2;
  return 1;
}
function sortByDirection(row) {
  row.sort((a, b) => dirRank(a) - dirRank(b));
}

function arrangePitchRows(starters, formation) {
  const digits = (formation || '')
    .split('-')
    .map((n) => parseInt(n, 10))
    .filter(Number.isFinite);
  const sum = digits.reduce((a, b) => a + b, 0);

  // Preferred strategy: when the formation digits add up to the outfield 10,
  // sort every outfielder by defensive→attacking rank and slice into the
  // declared row sizes. This honours formations like 3-4-2-1 where ESPN
  // labels the two wide attackers as LW/RW (which our bucket regex would
  // otherwise lump in with the striker).
  if (digits.length >= 2 && sum === starters.length - 1) {
    const ranked = [...starters].sort(
      (a, b) => positionRank(a.pos) - positionRank(b.pos)
    );
    const gkIdx = ranked.findIndex((p) => positionGroup(p.pos) === 'GK');
    const gk = gkIdx >= 0 ? ranked.splice(gkIdx, 1)[0] : ranked.shift();
    const rows = [[gk]];
    let i = 0;
    for (const size of digits) {
      const row = ranked.slice(i, i + size);
      sortByDirection(row);
      rows.push(row);
      i += size;
    }
    return rows;
  }

  // Fallback: classic group bucketing for unfamiliar formations.
  const groups = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of starters) groups[positionGroup(p.pos)].push(p);
  for (const k of Object.keys(groups)) sortByDirection(groups[k]);
  return [groups.GK, groups.DEF, groups.MID, groups.FWD].filter((r) => r.length);
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

async function ensureStats(eventId, { force = false } = {}) {
  const ev = state.events.find((e) => e.id === eventId);
  const cached = state.stats[eventId];
  const isLive = ev && ev.state === 'in';
  // A finished match whose cached timeline was captured mid-game (ESPN's summary
  // lags the scoreboard, so late goals were missing when it was cached) shows
  // fewer goals than the final score. Never treat such a cache as fresh — it
  // must refetch so all goals appear. Without this, the 2-hour TTL could pin a
  // stale "6 of 10 goals" timeline in place. (See timelineGoalCount/totalGoals.)
  const goalsIncomplete =
    ev &&
    ev.state === 'post' &&
    cached &&
    cached.timeline &&
    !cached.error &&
    cached.fetchedAt &&
    Date.now() - cached.fetchedAt > 30 * 1000 && // don't hammer if ESPN truly lacks the data
    timelineGoalCount(cached, ev) < totalGoals(ev);
  const isFresh =
    cached &&
    cached.fetchedAt &&
    !goalsIncomplete &&
    Date.now() - cached.fetchedAt < (isLive ? 12 * 1000 : STATS_CACHE_TTL_MS);
  if (!force && cached && isFresh && !cached.error) return;
  if (cached && cached.loading) return;
  // Error backoff: a failed fetch (e.g. ESPN 404 before a boxscore exists at
  // kickoff, or offline) is treated as fresh for 60s. Without this, the live
  // view's per-render ensureStats() loop would re-fetch + re-render forever.
  if (cached && cached.error && cached.fetchedAt && Date.now() - cached.fetchedAt < 60 * 1000) return;
  state.stats[eventId] = { ...(cached || {}), loading: true };
  try {
    const res = await fetch(`${STATS_BASE}?event=${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error('ESPN ' + res.status);
    const data = await res.json();
    const rows = extractStatRows(data);
    const timeline = extractTimeline(data);
    const lineups = extractLineups(data);
    const odds = extractOdds(data, ev);
    const info = {
      attendance: data?.gameInfo?.attendance || 0,
      referee: data?.gameInfo?.officials?.[0]?.displayName || '',
    };
    state.stats[eventId] = { rows, timeline, lineups, info, odds, fetchedAt: Date.now() };
    saveStatsCache();
    // Re-render if this match is on screen: expanded in a list, the live tab
    // (live matches are force-expanded but not in state.expanded), or the
    // Champions page (its star player + scorers come from this timeline).
    if (state.expanded.has(eventId) || state.filter === 'live' || state.filter === 'scorers' || state.filter === 'champions') render();
    updatePredictionsChip(); // MOTM bonus may now resolve
    if (predictionsDialog?.open) renderPredictionsList(); // star man may resolve
  } catch (err) {
    state.stats[eventId] = {
      error: 'Could not load stats.',
      fetchedAt: Date.now(),
    };
    if (state.expanded.has(eventId) || state.filter === 'live') render();
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
    if (t === 'own-goal' || /own[\s-]?goal/i.test(text)) {
      kind = 'own-goal';
    } else if (t === 'goal' || /^goal/i.test(text) || p?.scoringPlay) {
      kind = /penalty/i.test(text) && !/saved|missed/i.test(text)
        ? 'penalty-goal'
        : 'goal';
    } else if (/penalt/i.test(text) && /(miss|saved|wide|post|over)/i.test(text)) {
      // A penalty that didn't go in (missed, saved, hit the woodwork).
      kind = 'penalty-miss';
    } else if (t === 'yellow-card' || /yellow card/i.test(text)) {
      kind = 'yellow-card';
    } else if (t === 'red-card' || /red card/i.test(text)) {
      kind = 'red-card';
    } else if (t === 'substitution') {
      kind = 'sub';
    }
    if (!kind) continue;
    const players = p.participants || [];
    const player = players[0]?.athlete; // for subs: the player coming ON
    const assist = players[1]?.athlete; // for subs: the player going OFF
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

// Bookmaker odds → normalised win/draw/win percentages. ESPN's summary carries
// moneylines in `odds` / `pickcenter`; we convert each to an implied
// probability and divide out the overround so the three sum to 100.
function extractOdds(data, ev) {
  const o = (data?.odds && data.odds[0]) || (data?.pickcenter && data.pickcenter[0]);
  if (!o) return null;
  const h = impliedFromMoneyline(o.homeTeamOdds?.moneyLine);
  const a = impliedFromMoneyline(o.awayTeamOdds?.moneyLine);
  const d = impliedFromMoneyline(o.drawOdds?.moneyLine);
  if (h == null || a == null) return null;
  const draw = d == null ? 0 : d;
  const sum = h + a + draw;
  if (sum <= 0) return null;
  // Largest-remainder rounding so home + draw + away always total exactly 100
  // (independent Math.round can land on 99 or 101 and leave a gap in the bar).
  const raw = [h, a, draw].map((x) => (x / sum) * 100);
  const out = raw.map(Math.floor);
  let rem = 100 - out.reduce((s, v) => s + v, 0);
  const byFrac = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((p, q) => q.frac - p.frac);
  for (let k = 0; k < byFrac.length && rem > 0; k++, rem--) out[byFrac[k].i]++;
  return {
    home: out[0],
    away: out[1],
    draw: out[2],
    hasDraw: d != null,
    provider: o.provider?.name || '',
    live: ev?.state === 'in',
  };
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
  // The Next Match banner belongs to the Upcoming tab only.
  if (state.filter !== 'upcoming') {
    nextBannerEl.hidden = true;
    nextBannerEl.dataset.sig = ''; // force a rebuild when we return to Upcoming
    return;
  }
  const now = Date.now();
  // All upcoming pre-game matches, earliest kickoff first.
  const upcoming = state.events
    .filter((e) => e.state === 'pre' && new Date(e.date).getTime() > now)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (!upcoming.length) {
    nextBannerEl.hidden = true;
    return;
  }
  const t0 = new Date(upcoming[0].date).getTime();
  if (t0 - now > 48 * 60 * 60 * 1000) {
    nextBannerEl.hidden = true;
    return;
  }
  // Every match that shares the earliest kickoff instant — e.g. two group
  // games both at 9pm — sits under one shared countdown.
  const slot = upcoming.filter((e) => new Date(e.date).getTime() === t0);
  const ms = t0 - now;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const kickoff = new Date(t0);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isToday = sameLocalDay(kickoff, today);
  const isTomorrow = sameLocalDay(kickoff, tomorrow);
  const timeStr = formatTime(slot[0].date);
  // "Tonight" only reads right for an evening kickoff; daytime games say "Today".
  const todayWord = kickoff.getHours() >= 17 ? 'Tonight' : 'Today';
  const when = isToday
    ? `${todayWord} · ${timeStr}`
    : isTomorrow
    ? `Tomorrow · ${timeStr}`
    : `${kickoff.toLocaleDateString([], { weekday: 'short' })} · ${timeStr}`;
  const matchupHtml = (e) => {
    const homeName = e.home?.short || e.home?.name || 'TBD';
    const awayName = e.away?.short || e.away?.name || 'TBD';
    const homeLogo = e.home?.logo
      ? `<img class="next-flag" src="${escapeHtml(e.home.logo)}" alt="" loading="lazy" />`
      : '';
    const awayLogo = e.away?.logo
      ? `<img class="next-flag" src="${escapeHtml(e.away.logo)}" alt="" loading="lazy" />`
      : '';
    return `
      <div class="next-match" data-event-id="${escapeHtml(e.id)}" role="button" tabindex="0">
        <div class="next-team">${homeLogo}<span class="next-team-name">${escapeHtml(homeName)}</span></div>
        <span class="next-vs">vs</span>
        <div class="next-team">${awayLogo}<span class="next-team-name">${escapeHtml(awayName)}</span></div>
      </div>`;
  };
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const showHours = h > 0;
  const block = (val, unit) => `
    <div class="next-block">
      <div class="next-num"><span class="next-num-cur">${val}</span></div>
      <div class="next-unit">${unit}</div>
    </div>`;
  const countdownHtml = showHours
    ? `${block(hh, 'Hrs')}<span class="next-sep">:</span>${block(mm, 'Min')}<span class="next-sep">:</span>${block(ss, 'Sec')}`
    : `${block(mm, 'Min')}<span class="next-sep">:</span>${block(ss, 'Sec')}`;
  // Re-rendering the whole innerHTML every second would kill any digit
  // transitions. So: build the static frame once per slot change, then
  // only patch the .next-num values on subsequent ticks.
  const sig = `${slot.map((e) => e.id).join(',')}|${showHours}`;
  // Single-game click fallback; multi-game rows carry their own id.
  nextBannerEl.dataset.eventId = slot.length === 1 ? slot[0].id : '';
  if (nextBannerEl.dataset.sig !== sig) {
    nextBannerEl.hidden = false;
    nextBannerEl.dataset.sig = sig;
    nextBannerEl.classList.toggle('multi', slot.length > 1);
    nextBannerEl.innerHTML = `
      <div class="next-meta">
        <span class="next-label">${slot.length > 1 ? 'Next matches' : 'Next match'}</span>
        <span class="next-when">${escapeHtml(when)}</span>
      </div>
      <div class="next-matches">${slot.map(matchupHtml).join('')}</div>
      <div class="next-countdown-row">${countdownHtml}</div>
    `;
  } else {
    const nums = nextBannerEl.querySelectorAll('.next-num');
    const vals = showHours ? [hh, mm, ss] : [mm, ss];
    nums.forEach((el, i) => {
      const cur = el.querySelector('.next-num-cur');
      const prevVal = cur?.textContent ?? el.textContent;
      const nextVal = vals[i];
      if (prevVal === nextVal) return;
      // Flip-card roll: clone the current digit as the 'old' layer, drop
      // the new digit into the 'cur' layer, then let CSS animate them.
      const oldLayer = document.createElement('span');
      oldLayer.className = 'next-num-old';
      oldLayer.textContent = prevVal;
      // Reset any in-flight animation, then start fresh.
      el.classList.remove('flipping');
      // Drop any stale old-layer from a prior animation still in-flight.
      el.querySelectorAll('.next-num-old').forEach((n) => n.remove());
      if (cur) cur.textContent = nextVal;
      else el.innerHTML = `<span class="next-num-cur">${nextVal}</span>`;
      el.appendChild(oldLayer);
      // Force reflow so the new keyframes restart cleanly.
      void el.offsetWidth;
      el.classList.add('flipping');
      // Clean up the old layer once the roll finishes (matches 0.45s anim).
      setTimeout(() => {
        oldLayer.remove();
        el.classList.remove('flipping');
      }, 460);
    });
  }
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function skeletonList(count = 5) {
  return `
    <section class="day">
      <div class="skeleton-line"></div>
      ${Array.from({ length: count }, () => '<div class="skeleton-card"></div>').join('')}
    </section>`;
}

function applyEntranceAnimation() {
  if (!state.animateNext || prefersReducedMotion()) {
    state.animateNext = false;
    return;
  }
  state.animateNext = false;
  matchesEl.querySelectorAll('.match, .group-card').forEach((el, i) => {
    el.style.setProperty('--i', Math.min(i, 12));
    el.classList.add('card-in');
  });
}

function qualClass(t) {
  return t.rank <= 2 ? 'qual-direct' : t.rank === 3 ? 'qual-maybe' : '';
}

// A team's group-stage results in order (oldest→newest) as 'w' | 'd' | 'l'.
// A group game is one against another team in the SAME group — identifying them
// by opponent (not by date) avoids a final-matchday game that straddles the
// knockout date being dropped. Drives the coloured form dots.
function teamGroupForm(abbr, groupAbbrs) {
  return state.events
    .filter((e) => {
      if (e.state !== 'post') return false;
      const isHome = e.home?.abbr === abbr;
      const isAway = e.away?.abbr === abbr;
      if (!isHome && !isAway) return false;
      const opp = isHome ? e.away?.abbr : e.home?.abbr;
      return opp && groupAbbrs.has(opp);
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((e) => {
      const home = e.home?.abbr === abbr;
      const me = parseInt((home ? e.home : e.away)?.score, 10);
      const opp = parseInt((home ? e.away : e.home)?.score, 10);
      if (!Number.isFinite(me) || !Number.isFinite(opp)) return null;
      return me > opp ? 'w' : me < opp ? 'l' : 'd';
    })
    .filter(Boolean);
}

function formDots(abbr, groupAbbrs) {
  const form = teamGroupForm(abbr, groupAbbrs);
  if (!form.length) return '<span class="gt-form-empty">–</span>';
  const label = { w: 'Win', d: 'Draw', l: 'Loss' };
  return form
    .map((r) => `<span class="form-dot ${r}" title="${label[r]}"></span>`)
    .join('');
}

function groupsHTML() {
  const s = state.standings;
  if (!s || !s.groups?.length) {
    return state.standingsError
      ? `<p class="empty">Couldn't load the group tables. Pull to refresh or try again later.</p>`
      : `<div class="groups-grid">${Array.from({ length: 4 }, () => '<div class="skeleton-card group-skel"></div>').join('')}</div>`;
  }
  const cards = s.groups
    .map((g) => {
      const groupAbbrs = new Set(g.entries.map((en) => en.abbr));
      const rows = g.entries
        .map((t) => {
          const color = safeHex(t.noteColor);
          return `
          <tr class="${qualClass(t)}" title="${escapeHtml(t.noteDesc)}">
            <td class="gt-pos"><span class="pos-chip"${color ? ` style="--qual:${color}"` : ''}>${t.rank || ''}</span></td>
            <td class="gt-team" data-team-abbr="${escapeHtml(t.abbr)}" role="button" tabindex="0">
              ${t.logo ? `<img class="gt-logo" src="${escapeHtml(t.logo)}" alt="" loading="lazy" />` : ''}
              <span class="gt-name">${escapeHtml(t.name)}</span>
            </td>
            <td class="gt-p">${escapeHtml(t.gp)}</td>
            <td class="gt-form">${formDots(t.abbr, groupAbbrs)}</td>
            <td class="gt-gd">${escapeHtml(t.gd)}</td>
            <td class="gt-pts">${escapeHtml(t.pts)}</td>
          </tr>`;
        })
        .join('');
      return `
      <section class="group-card">
        <h2 class="group-title">${escapeHtml(g.name)}</h2>
        <table class="group-table">
          <thead>
            <tr><th class="gt-pos"></th><th class="gt-team">Team</th><th class="gt-p">P</th><th class="gt-form">Form</th><th class="gt-gd">GD</th><th class="gt-pts">Pts</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    })
    .join('');
  return `
    <div class="groups-grid">${cards}</div>
    <p class="groups-legend">
      <span class="legend-dot direct"></span> Top 2 advance
      <span class="legend-dot maybe"></span> Best 8 third-placed advance
    </p>`;
}

function renderGroupsView() {
  matchesEl.innerHTML = groupsHTML();
  ensureStandings(); // background refresh when stale
  if (state.standings?.groups?.length) applyEntranceAnimation();
}

function liveHTML() {
  const evs = liveTabEvents();
  if (!evs.length) {
    return `<p class="empty">No live match right now. The LIVE tab opens around kickoff time.</p>`;
  }
  // With several games at once, show a switcher and one game at a time so each
  // gets the full hero treatment instead of an endless stacked scroll.
  let sel = state.liveSelected ? evs.find((e) => e.id === state.liveSelected) : null;
  if (!sel) {
    sel = evs[0];
    state.liveSelected = sel.id; // heal a stale/empty selection (e.g. a game ended)
  }
  // The World Cup Final gets its own epic golden stage instead of the ordinary
  // red live card.
  if (isFinalMatch(sel)) {
    const switcher = evs.length > 1 ? liveSwitcherHTML(evs, sel.id) : '';
    return `<section class="day live-only final-stage-wrap">${switcher}${finalStageHTML(sel)}</section>`;
  }
  const switcher = evs.length > 1 ? liveSwitcherHTML(evs, sel.id) : '';
  const card =
    sel.state === 'in'
      ? matchCard(sel, { hero: true, forceExpand: true })
      : preKickoffCard(sel);
  return `<section class="day live-only">${switcher}${card}</section>`;
}

// The epic World Cup Final stage — golden, ceremonial. Frames the same live
// match card (score, timeline, stats) inside a "THE FINAL" hero so the biggest
// game of the tournament never looks like an ordinary fixture.
function finalStageHTML(e) {
  const live = e.state === 'in';
  const done = e.state === 'post';
  const homeName = e.home?.short || e.home?.name || 'TBD';
  const awayName = e.away?.short || e.away?.name || 'TBD';
  const flag = (tm, cls) =>
    tm?.logo
      ? `<img class="fin-flag ${cls}" src="${escapeHtml(tm.logo)}" alt="${escapeHtml(tm.name || '')}" loading="lazy" />`
      : `<span class="fin-flag ${cls} placeholder">${escapeHtml((tm?.abbr || '?').slice(0, 3))}</span>`;
  // Centre column: countdown before kickoff, live score while playing, FT after.
  let centre;
  if (live) {
    centre = `
      <div class="fin-score">
        <span class="fin-num">${escapeHtml(String(e.home?.score ?? 0))}</span>
        <span class="fin-dash">–</span>
        <span class="fin-num">${escapeHtml(String(e.away?.score ?? 0))}</span>
      </div>
      <span class="fin-live-min"><span class="fin-live-dot"></span>${escapeHtml(e.detail || 'LIVE')}</span>`;
  } else if (done) {
    const pens = e.shootout
      ? `<span class="fin-pens">${e.shootout.home}–${e.shootout.away} pens</span>`
      : '';
    centre = `
      <div class="fin-score">
        <span class="fin-num">${escapeHtml(String(e.home?.score ?? 0))}</span>
        <span class="fin-dash">–</span>
        <span class="fin-num">${escapeHtml(String(e.away?.score ?? 0))}</span>
      </div>
      <span class="fin-ft">Full time</span>${pens}`;
  } else {
    centre = `
      <div class="fin-countdown" id="fin-countdown" data-kickoff="${escapeHtml(e.date)}">
        ${finalCountdownInner(e.date)}
      </div>
      <span class="fin-koff">Kicks off ${escapeHtml(formatTime(e.date))}</span>`;
  }
  const venue = e.venue
    ? `<div class="fin-venue">📍 ${escapeHtml(e.venue)}${e.city ? ', ' + escapeHtml(e.city) : ''}</div>`
    : '';
  // The live/finished body reuses the normal expanded match view (win
  // probability, timeline, stats, lineups). Pre-kickoff shows the prediction
  // panel so a call can still be made right up to kickoff.
  const body = live || done
    ? matchCard(e, { hero: true, forceExpand: true })
    : `<div class="match pre expanded final-pre" data-event-id="${escapeHtml(e.id)}"><div class="game-info">${oddsWidget(e)}${renderPredictionPanel(e)}</div></div>`;
  return `
    <div class="final-stage${live ? ' is-live' : ''}${done ? ' is-done' : ''}">
      <div class="fin-rays" aria-hidden="true"></div>
      <header class="fin-head">
        <div class="fin-trophy" aria-hidden="true">🏆</div>
        <div class="fin-kicker">FIFA World Cup 2026</div>
        <h2 class="fin-title">THE FINAL</h2>
        ${venue}
      </header>
      <div class="fin-teams">
        <div class="fin-team home">${flag(e.home, 'home')}<span class="fin-team-name">${escapeHtml(homeName)}</span></div>
        <div class="fin-centre">${centre}</div>
        <div class="fin-team away">${flag(e.away, 'away')}<span class="fin-team-name">${escapeHtml(awayName)}</span></div>
      </div>
    </div>
    ${body}`;
}

// The h/m/s digits inside the pre-kickoff countdown. Recomputed each second by
// tickFinalCountdown() without a full re-render.
function finalCountdownInner(kickoffIso) {
  const ms = new Date(kickoffIso).getTime() - Date.now();
  if (ms <= 0) {
    return `<span class="fin-cd-soon"><span class="fin-cd-pulse"></span>Any moment now…</span>`;
  }
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const cell = (v, label) =>
    `<span class="fin-cd-cell"><b>${String(v).padStart(2, '0')}</b><small>${label}</small></span>`;
  return `${cell(h, 'hrs')}${cell(m, 'min')}${cell(s, 'sec')}`;
}

// Drives the pre-kickoff countdown once a second. Self-stops when the element
// leaves the DOM (tab switched away) or kickoff arrives.
let finalCountdownTimer = null;
function tickFinalCountdown() {
  const el = document.getElementById('fin-countdown');
  if (!el) {
    if (finalCountdownTimer) { clearInterval(finalCountdownTimer); finalCountdownTimer = null; }
    return;
  }
  const iso = el.dataset.kickoff;
  el.innerHTML = finalCountdownInner(iso);
  // Kickoff reached — re-render so the stage flips to the live/waiting view.
  if (new Date(iso).getTime() - Date.now() <= 0) {
    if (finalCountdownTimer) { clearInterval(finalCountdownTimer); finalCountdownTimer = null; }
  }
}
function syncFinalCountdown() {
  const needed = !!document.getElementById('fin-countdown');
  if (needed && !finalCountdownTimer) {
    finalCountdownTimer = setInterval(tickFinalCountdown, 1000);
  } else if (!needed && finalCountdownTimer) {
    clearInterval(finalCountdownTimer);
    finalCountdownTimer = null;
  }
}

// --- Champions page --------------------------------------------------------
// The grand finale. Once the Final is won, this becomes the app's front page:
// the winning nation, their flag, the trophy, a burst of confetti, the star of
// the final, and the whole champion squad — plus a way into the full stats.

// Find a player's photo (and jersey) by name within a team's squad, matching on
// last name so "K. Mbappé" still resolves to the photos.json entry.
function squadPhotoByName(abbr, name) {
  if (!name) return null;
  const key = lastNameKey(name);
  for (const p of squadList(abbr)) {
    if (lastNameKey(p.name) === key) return p;
  }
  return null;
}

// Goals scored in the final, grouped by scorer for the winning side, most goals
// first. Drives the "how they won it" scorer line.
function finalScorers(e, side) {
  const entry = state.stats[e.id];
  if (!entry || !entry.timeline) return [];
  const tally = new Map();
  for (const t of entry.timeline) {
    if (t.kind !== 'goal' && t.kind !== 'penalty-goal') continue;
    if (timelineSide(t, e) !== side) continue;
    const key = lastNameKey(t.player);
    const cur = tally.get(key) || { name: t.player, mins: [] };
    cur.mins.push(t.minute || '');
    tally.set(key, cur);
  }
  return [...tally.values()].sort((a, b) => b.mins.length - a.mins.length);
}

function championsHTML(ev) {
  const e = ev || finalMatch();
  if (!e || e.state !== 'post') {
    return `<p class="empty">The champions will be crowned right here after the final whistle.</p>`;
  }
  const wSide = winnerSide(e);
  const win = wSide === 'home' ? e.home : e.away;
  const lose = wSide === 'home' ? e.away : e.home;
  if (!win) return `<p class="empty">Awaiting the final result…</p>`;

  const winColor = safeHex(win.color) || '#c8a24a';
  const winScore = wSide === 'home' ? e.home?.score : e.away?.score;
  const loseScore = wSide === 'home' ? e.away?.score : e.home?.score;
  const pens = e.shootout
    ? `<span class="ch-pens">(${wSide === 'home' ? e.shootout.home : e.shootout.away}–${wSide === 'home' ? e.shootout.away : e.shootout.home} on penalties)</span>`
    : '';

  const winFlag = win.logo
    ? `<img class="ch-flag" src="${escapeHtml(win.logo)}" alt="${escapeHtml(win.name || '')} flag" />`
    : `<span class="ch-flag placeholder">${escapeHtml((win.abbr || '?').slice(0, 3))}</span>`;
  const smallFlag = (tm) =>
    tm?.logo
      ? `<img class="ch-mini-flag" src="${escapeHtml(tm.logo)}" alt="" loading="lazy" />`
      : `<span class="ch-mini-flag placeholder">${escapeHtml((tm?.abbr || '?').slice(0, 3))}</span>`;

  // Confetti: a fixed set of pieces, tinted with the winner's colour, gold, and
  // white. Positions/delays are deterministic (no Math.random — resume-safe).
  const confettiColors = [winColor, '#ffd447', '#ffffff', winColor, '#ffe58a'];
  const confetti = Array.from({ length: 40 }, (_, i) => {
    const left = (i * 2.5 + (i % 5) * 3) % 100;
    const delay = ((i % 10) * 0.35).toFixed(2);
    const dur = (3 + (i % 6) * 0.5).toFixed(2);
    const color = confettiColors[i % confettiColors.length];
    const tilt = (i % 2 ? 1 : -1) * (20 + (i % 4) * 12);
    return `<span class="ch-confetti" style="left:${left}%;background:${color};animation-delay:${delay}s;animation-duration:${dur}s;--tilt:${tilt}deg"></span>`;
  }).join('');

  // Star of the final.
  const star = superiorPlayer(e);
  let starCard = '';
  if (star) {
    const sp = squadPhotoByName(star.abbr, star.name) || squadPhotoByName(e.home?.abbr, star.name) || squadPhotoByName(e.away?.abbr, star.name);
    const photo = sp?.photo;
    const bits = [];
    if (star.goals) bits.push(`${star.goals} goal${star.goals === 1 ? '' : 's'}`);
    if (star.assists) bits.push(`${star.assists} assist${star.assists === 1 ? '' : 's'}`);
    const photoEl = photo
      ? `<img class="ch-star-photo" src="${escapeHtml(photo)}" alt="${escapeHtml(star.name)}" />`
      : `<span class="ch-star-photo placeholder">${escapeHtml((star.abbr || '').slice(0, 3))}</span>`;
    starCard = `
      <div class="ch-star">
        <span class="ch-star-badge">⭐ Star of the Final</span>
        ${photoEl}
        <div class="ch-star-id">
          <span class="ch-star-name">${escapeHtml(star.name)}</span>
          ${bits.length ? `<span class="ch-star-line">${escapeHtml(bits.join(' · '))}</span>` : ''}
        </div>
      </div>`;
  }

  // How they won it — winner's scorers in the final.
  const scorers = finalScorers(e, wSide);
  const scorersCard = scorers.length
    ? `<div class="ch-scorers">
         <h3 class="ch-sec-title">How they won it</h3>
         <ul class="ch-scorer-list">
           ${scorers.map((s) => `<li><span class="ch-ball">⚽</span><span class="ch-scorer-name">${escapeHtml(s.name)}</span><span class="ch-scorer-mins">${escapeHtml(s.mins.filter(Boolean).join(', '))}</span></li>`).join('')}
         </ul>
       </div>`
    : '';

  // The champion squad — every player's photo.
  const squad = squadList(win.abbr);
  const squadGrid = squad.length
    ? `<div class="ch-squad">
         <h3 class="ch-sec-title">${escapeHtml(win.short || win.name)} — World Champions</h3>
         <div class="ch-squad-grid">
           ${squad.map((p) => `
             <figure class="ch-player" data-player-photo="${escapeHtml(p.photo || '')}" data-player-name="${escapeHtml(p.name)}" data-player-team="${escapeHtml(ABBR_TO_GUARDIAN[win.abbr] || '')}" data-player-pos="${escapeHtml(p.pos || '')}" data-player-jersey="${escapeHtml(String(p.num))}" data-player-abbr="${escapeHtml(win.abbr || '')}" role="button" tabindex="0">
               ${p.photo
                 ? `<img class="ch-player-photo" src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.name)}" loading="lazy" />`
                 : `<span class="ch-player-photo placeholder">${escapeHtml(String(p.num))}</span>`}
               <figcaption class="ch-player-name">${escapeHtml(p.name)}</figcaption>
             </figure>`).join('')}
         </div>
       </div>`
    : '';

  return `
    <section class="champions" style="--win:${winColor}">
      <div class="ch-confetti-layer" aria-hidden="true">${confetti}</div>
      <div class="ch-hero">
        <div class="ch-rays" aria-hidden="true"></div>
        <div class="ch-kicker"><span class="ch-kicker-line"></span>FIFA World Cup 2026<span class="ch-kicker-line"></span></div>
        <div class="ch-trophy" aria-hidden="true">🏆</div>
        <div class="ch-flag-ring">${winFlag}</div>
        <h1 class="ch-country">${escapeHtml(win.name || win.short || '')}</h1>
        <div class="ch-crown">World Champions</div>
        <div class="ch-stars" aria-hidden="true">★ ★ ★</div>
      </div>

      <div class="ch-scoreline">
        <div class="ch-sl-team win">${smallFlag(win)}<span class="ch-sl-name">${escapeHtml(win.short || win.abbr)}</span></div>
        <div class="ch-sl-score"><b>${escapeHtml(String(winScore ?? 0))}</b><span>–</span><b>${escapeHtml(String(loseScore ?? 0))}</b></div>
        <div class="ch-sl-team">${smallFlag(lose)}<span class="ch-sl-name">${escapeHtml(lose?.short || lose?.abbr || '')}</span></div>
      </div>
      <div class="ch-final-meta">Final${pens ? ' ' + pens : ''}${e.venue ? ` · ${escapeHtml(e.venue)}` : ''}</div>

      ${starCard}
      ${scorersCard}
      ${squadGrid}

      <button type="button" class="ch-stats-btn" data-champ-stats="${escapeHtml(e.id)}">View full match &amp; stats →</button>
    </section>`;
}

// A segmented switcher across simultaneous live/imminent games. Each chip
// identifies its match (flags + abbreviations) and shows the live score or a
// "soon" hint, with a pulsing dot for games already in progress.
function liveSwitcherHTML(evs, selId) {
  const flag = (tm) =>
    tm?.logo
      ? `<img class="lsw-flag" src="${escapeHtml(tm.logo)}" alt="" loading="lazy" />`
      : '<span class="lsw-flag placeholder"></span>';
  const chips = evs
    .map((e) => {
      const live = e.state === 'in';
      const ha = e.home?.abbr || e.home?.short || '—';
      const aa = e.away?.abbr || e.away?.short || '—';
      const mid = live
        ? `<span class="lsw-score">${escapeHtml(String(e.home?.score ?? 0))}–${escapeHtml(String(e.away?.score ?? 0))}</span>`
        : `<span class="lsw-vs">v</span>`;
      const status = live
        ? `<span class="lsw-min">${escapeHtml(e.detail || 'LIVE')}</span>`
        : `<span class="lsw-min soon">soon</span>`;
      return `
        <button type="button" class="live-switch-chip${e.id === selId ? ' active' : ''}${live ? ' is-live' : ''}" data-live-select="${escapeHtml(e.id)}" role="tab" aria-selected="${e.id === selId}">
          <span class="lsw-teams">${live ? '<span class="lsw-dot"></span>' : ''}${flag(e.home)}<span class="lsw-abbr">${escapeHtml(ha)}</span>${mid}<span class="lsw-abbr">${escapeHtml(aa)}</span>${flag(e.away)}</span>
          ${status}
        </button>`;
    })
    .join('');
  return `<div class="live-switch" role="tablist" aria-label="Live matches">${chips}</div>`;
}

// Shown in the LIVE tab for a match that's imminent but hasn't kicked off.
// If its scheduled time has already passed we say "waiting for kickoff".
function preKickoffCard(e) {
  const now = Date.now();
  const t = new Date(e.date).getTime();
  const late = now >= t;
  const mins = Math.max(0, Math.ceil((t - now) / 60000));
  const flag = (tm) =>
    tm?.logo
      ? `<img class="lk-flag" src="${escapeHtml(tm.logo)}" alt="" loading="lazy" />`
      : '<span class="lk-flag placeholder"></span>';
  const homeName = e.home?.short || e.home?.name || 'TBD';
  const awayName = e.away?.short || e.away?.name || 'TBD';
  const status = late
    ? `<span class="lk-badge waiting"><span class="lk-pulse"></span>Waiting for kickoff…</span>
       <span class="lk-sub">Scheduled ${escapeHtml(formatTime(e.date))} · should start any moment</span>`
    : `<span class="lk-badge soon"><span class="lk-pulse"></span>Kicks off in ${mins} min</span>
       <span class="lk-sub">${escapeHtml(formatTime(e.date))}</span>`;
  return `
    <article class="match hero live-kickoff" data-event-id="${escapeHtml(e.id)}">
      <div class="lk-teams">
        <div class="lk-team">${flag(e.home)}<span class="lk-name">${escapeHtml(homeName)}</span></div>
        <span class="lk-vs">vs</span>
        <div class="lk-team">${flag(e.away)}<span class="lk-name">${escapeHtml(awayName)}</span></div>
      </div>
      <div class="lk-status">${status}</div>
    </article>`;
}

// --- Preview mode ----------------------------------------------------------
// A hidden way to see the Final stage and Champions page before they happen for
// real: add #preview=final, #preview=final-live, or #preview=champions to the
// URL. Strictly opt-in via the hash, so it never affects normal use.
function previewMode() {
  const m = /(?:^|[#&])preview=([\w-]+)/.exec(location.hash || '');
  return m ? m[1] : null;
}

// A demo Final event for a given preview state — built from the real Final so
// flags/venue are genuine, without mutating the real event or its cache.
function previewEvent(mode) {
  const f = finalMatch();
  if (!f) return null;
  const e = JSON.parse(JSON.stringify(f));
  if (mode === 'final-live') {
    e.state = 'in'; e.detail = "67'";
    e.home.score = '2'; e.away.score = '1';
  } else if (mode === 'champions') {
    e.id = f.id + '::preview';
    e.state = 'post'; e.completed = true; e.winner = 'home';
    e.home.score = '2'; e.away.score = '1';
    // Synthesise a timeline from the real winning squad so the star player and
    // scorer list show real names + photos. In-memory only (never saved).
    const squad = squadList(e.home.abbr);
    if (!state.stats[e.id] && squad.length) {
      const fwds = squad.filter((p) => p.pos === 'FWD');
      const star = fwds[0] || squad[squad.length - 1];
      const loseSquad = squadList(e.away.abbr);
      const loseFwd = loseSquad.filter((p) => p.pos === 'FWD')[0] || loseSquad[loseSquad.length - 1];
      const tl = [];
      if (star) tl.push({ kind: 'goal', minute: "23'", clockValue: 1380, teamName: e.home.name, player: star.name });
      if (loseFwd) tl.push({ kind: 'goal', minute: "58'", clockValue: 3480, teamName: e.away.name, player: loseFwd.name });
      if (star) tl.push({ kind: 'goal', minute: "81'", clockValue: 4860, teamName: e.home.name, player: star.name });
      state.stats[e.id] = { fetchedAt: Date.now(), timeline: tl, rows: [], lineups: null, odds: null, info: {} };
    }
  } else { // 'final' (pre-kickoff)
    e.state = 'pre';
  }
  return e;
}

// Leave preview mode: drop the #preview hash and repaint the normal app.
function exitPreview() {
  if (finalCountdownTimer) { clearInterval(finalCountdownTimer); finalCountdownTimer = null; }
  history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.remove('final-mode', 'champions-mode');
  render();
}

function previewHTML(mode) {
  const e = previewEvent(mode);
  if (!e) return '<p class="empty">Preview needs the Final to be in the schedule.</p>';
  const label = mode === 'champions' ? 'Champions page'
    : mode === 'final-live' ? 'The Final — live' : 'The Final — pre-kickoff';
  const links = ['final', 'final-live', 'champions']
    .map((m) => `<a class="preview-link${m === mode ? ' on' : ''}" href="#preview=${m}">${m === 'final' ? 'Pre' : m === 'final-live' ? 'Live' : 'Champions'}</a>`)
    .join('');
  const bar = `<div class="preview-bar"><span class="preview-tag">PREVIEW</span><span class="preview-what">${escapeHtml(label)}</span><span class="preview-links">${links}</span><button type="button" class="preview-exit" data-preview-exit>Exit ✕</button></div>`;
  if (mode === 'champions') return bar + championsHTML(e);
  return bar + `<section class="day live-only final-stage-wrap">${finalStageHTML(e)}</section>`;
}

function listHTML() {
  const filtered = filterEvents(state.events);
  if (!filtered.length) {
    return state.events.length
      ? `<p class="empty">No matches match this filter.</p>`
      : skeletonList();
  }
  // Live matches stay in their normal day group as ordinary (live-styled)
  // cards — the dedicated red "Live now" hero only lives in the LIVE tab now.
  const groups = groupByDay(filtered);
  return groups
    .map(
      ([day, evs]) => `
      <section class="day">
        <h2 class="day-header">${escapeHtml(formatDayLabel(day))}</h2>
        ${evs.map(matchCard).join('')}
      </section>
    `
    )
    .join('');
}

// Build the markup for ANY tab from current state, with no side effects.
// The swipe carousel renders the neighbouring tabs with this. filterEvents()
// keys off state.filter, so we briefly borrow it and always restore it.
function viewHTML(filter) {
  const saved = state.filter;
  state.filter = filter;
  try {
    switch (filter) {
      case 'live': return liveHTML();
      case 'champions': return championsHTML();
      case 'groups': return groupsHTML();
      case 'bracket': return bracketHTML();
      case 'scorers': return scorersHTML();
      default: return listHTML();
    }
  } finally {
    state.filter = saved;
  }
}

// Paint the whole shell red while the LIVE tab is active (header, pills,
// status bar) — not just the match cards.
function setLiveMode(on, goldFinal = false) {
  // The Final wears gold, not the ordinary live red.
  document.body.classList.toggle('live-mode', on && !goldFinal);
  document.body.classList.toggle('final-mode', on && goldFinal);
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.content = on ? (goldFinal ? '#a9791a' : '#b00d1c') : (state.filter === 'champions' ? '#a9791a' : '#0c5c3c');
  }
}

// Is the LIVE tab currently focused on the Final? (drives gold theming)
function liveShowingFinal() {
  if (state.filter !== 'live') return false;
  const evs = liveTabEvents();
  if (!evs.length) return false;
  const sel = (state.liveSelected && evs.find((e) => e.id === state.liveSelected)) || evs[0];
  return isFinalMatch(sel);
}

function render() {
  // Preview mode (#preview=…) short-circuits the normal tab logic.
  const pv = previewMode();
  if (pv) {
    document.body.classList.remove('live-mode');
    document.body.classList.toggle('final-mode', pv !== 'champions');
    document.body.classList.toggle('champions-mode', pv === 'champions');
    matchesEl.innerHTML = previewHTML(pv);
    if (pv === 'champions' && !photoDb) ensurePhotoDb().then(() => { if (previewMode()) render(); });
    syncFinalCountdown();
    applyEntranceAnimation();
    updateLivePolling();
    if (nextBannerEl) nextBannerEl.hidden = true;
    updateIndicator(true);
    return;
  }
  const onChampions = state.filter === 'champions' && !state.search.trim();
  setLiveMode(state.filter === 'live' && !state.search.trim(), liveShowingFinal());
  document.body.classList.toggle('champions-mode', onChampions);
  if (onChampions) {
    matchesEl.innerHTML = championsHTML();
    const f = finalMatch();
    if (f) ensureStats(f.id); // load timeline/stats so the standout resolves
    // Champion squad photos need photos.json — re-render once it lands.
    if (!photoDb) ensurePhotoDb().then(() => { if (state.filter === 'champions') render(); });
    applyEntranceAnimation();
    updateLivePolling();
    if (nextBannerEl) nextBannerEl.hidden = true;
    updatePredictionsChip();
    updateIndicator(true);
    return;
  }
  // Search overrides the active tab: show every game that matches the query.
  if (state.search.trim()) {
    matchesEl.innerHTML = searchHTML();
    applyEntranceAnimation();
    updateLivePolling();
    if (nextBannerEl) nextBannerEl.hidden = true;
    updatePredictionsChip();
    updateIndicator(true);
    return;
  }
  if (state.filter === 'live') {
    matchesEl.innerHTML = liveHTML();
    for (const e of state.events.filter((x) => x.state === 'in')) ensureStats(e.id);
    // The Final's pre-kickoff stage wants odds loaded so the win-probability
    // bar can reveal, and a ticking countdown to kickoff.
    const f = finalMatch();
    if (f && f.state !== 'post') ensureStats(f.id);
    syncFinalCountdown();
    applyEntranceAnimation();
    updateLivePolling();
    updateNextBanner();
    updatePredictionsChip();
    updateIndicator(true);
    return;
  }
  if (state.filter === 'groups') {
    renderGroupsView();
    updateLivePolling();
    updateNextBanner();
    updateIndicator(true);
    return;
  }
  if (state.filter === 'bracket') {
    renderBracketView();
    updateLivePolling();
    updateNextBanner();
    updateIndicator(true);
    return;
  }
  if (state.filter === 'scorers') {
    renderScorersView();
    updateLivePolling();
    updateNextBanner();
    updateIndicator(true);
    return;
  }
  matchesEl.innerHTML = listHTML();
  applyEntranceAnimation();
  updateLivePolling();
  updateNextBanner();
  updatePredictionsChip();
  updateIndicator(true);
  // Refresh stats for any expanded live match.
  for (const id of state.expanded) {
    const ev = state.events.find((e) => e.id === id);
    if (ev && ev.state === 'in') ensureStats(id);
  }
}

// --- Pull-to-refresh (touch devices) ---------------------------------------

(() => {
  const ptrEl = $('#ptr');
  if (!ptrEl || !('ontouchstart' in window)) return;
  let startY = 0;
  let dist = 0;
  let active = false;
  let refreshing = false;
  const THRESHOLD = 70;
  document.addEventListener(
    'touchstart',
    (e) => {
      if (window.scrollY > 5 || refreshing) return;
      startY = e.touches[0].clientY;
      active = true;
      dist = 0;
    },
    { passive: true }
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!active || refreshing) return;
      dist = e.touches[0].clientY - startY;
      if (dist <= 10 || window.scrollY > 5) {
        ptrEl.classList.remove('visible', 'armed');
        return;
      }
      const capped = Math.min(dist, 110);
      ptrEl.classList.add('visible');
      ptrEl.style.setProperty('--pull', `${capped * 0.5}px`);
      ptrEl.classList.toggle('armed', capped > THRESHOLD);
    },
    { passive: true }
  );
  document.addEventListener(
    'touchend',
    async () => {
      if (!active) return;
      active = false;
      if (dist > THRESHOLD && !refreshing) {
        refreshing = true;
        ptrEl.classList.add('refreshing');
        try {
          await load({ force: true });
          if (state.filter === 'groups') await ensureStandings(true);
        } finally {
          refreshing = false;
          ptrEl.classList.remove('refreshing', 'visible', 'armed');
          ptrEl.style.removeProperty('--pull');
        }
      } else {
        ptrEl.classList.remove('visible', 'armed');
        ptrEl.style.removeProperty('--pull');
      }
      dist = 0;
    },
    { passive: true }
  );
})();

ensurePhotoDb();
requestPersistentStorage();
load();
ensureStandings();
syncLiveTab();
syncChampionsTab();

// Park the tab bubble under the active tab on first paint, and keep it
// aligned when the viewport (and therefore the pill layout) changes.
updateIndicator(false);
window.addEventListener('resize', () => updateIndicator(false));
window.addEventListener('orientationchange', () => updateIndicator(false));
