# World Cup 2026 — PWA

A tiny progressive web app that lists every FIFA World Cup 2026 fixture in your
phone's local timezone. Data comes from ESPN's public scoreboard endpoint
(no API key, no signup). Works offline after the first load.

```
.
├── index.html
├── styles.css
├── app.js
├── manifest.webmanifest
├── service-worker.js
└── icons/
    ├── icon-192.png
    ├── icon-512.png
    └── icon-1024.png      (used later for Android/iOS app icons)
```

---

## Step 1 — Get it on your Android phone (today)

The fastest path is GitHub Pages + Chrome's "Add to Home Screen".

1. Create a new public GitHub repo (e.g. `world-cup-2026`).
2. Drop every file in this folder into the repo root and push.
3. In the repo: **Settings → Pages → Build from branch → `main` / `(root)` → Save**.
4. After ~1 minute, your app is live at
   `https://<your-username>.github.io/world-cup-2026/`.
5. On your Android phone, open that URL in **Chrome**.
6. Tap the **⋮** menu → **Add to Home screen** → **Install**.

You now have an icon on your home screen that opens fullscreen, with no browser
chrome. Works offline. Behaves like a real app.

### iPhone (today)

Same URL, opened in **Safari** (not Chrome — iOS requires Safari for this).
Tap the **Share** button → **Add to Home Screen**. Same fullscreen behaviour,
though iOS Safari's PWA support is more limited than Android Chrome's.

---

## Step 2 — Real native app for Google Play and App Store (when you're ready)

This codebase is intentionally a plain static web app, which is exactly what
**Capacitor** (by Ionic) needs to wrap into native Android and iOS apps. You
keep the same `index.html`/`app.js`/`styles.css` and Capacitor compiles it into
real installable binaries.

You'll do this on a computer with Node.js installed. From this folder:

```bash
npm init -y
npm install @capacitor/core @capacitor/cli
npx cap init "World Cup 2026" "com.yourname.worldcup" --web-dir="."
npm install @capacitor/android @capacitor/ios
npx cap add android
npx cap add ios          # macOS only
npx cap sync
```

Then:

- **Android build** (Windows or Mac): `npx cap open android` → opens Android
  Studio → Build → Generate Signed Bundle / APK → upload to Google Play.
- **iOS build** (Mac only): `npx cap open ios` → opens Xcode → sign with your
  Apple Developer account → archive → upload to App Store Connect.

Capacitor will pick up `icons/icon-1024.png` as a starting point — once you're
serious, regenerate icons with a tool like
[`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets) so you
get every size each store requires.

### Whenever you change the code

```bash
npx cap sync
```

That copies the latest web build into the native projects.

---

## How it works (one paragraph)

`app.js` loops through every date from 2026‑06‑11 to 2026‑07‑19 and calls
`site.api.espn.com/.../fifa.world/scoreboard?dates=YYYYMMDD`. That endpoint is
CORS-friendly so the browser can hit it directly — no backend. Results are
cached in `localStorage` for 15 minutes, and the service worker also caches
network responses so the app works offline. Kickoff times are rendered with
`Date.toLocaleTimeString()`, which automatically uses your device's timezone.

## Customising

- **Different tournament year:** change `TOURNAMENT_START` and `TOURNAMENT_END`
  in `app.js`.
- **Show a specific team only:** add a filter button in `index.html` and a case
  in `filterEvents()` in `app.js`.
- **Theme:** edit the CSS variables at the top of `styles.css`.

## Known limits

- ESPN's endpoint is undocumented and could change. If it ever stops working,
  swap `fetchDate()` in `app.js` for another provider (e.g.
  football-data.org's free tier with an API key).
- Knockout-round fixtures show "TBD" team names until ESPN updates them after
  group play.
