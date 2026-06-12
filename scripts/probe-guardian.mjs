// One-shot probe to find where The Guardian's WC 2026 interactive
// loads its player data from.
const js = await fetch(
  'https://interactive.guim.co.uk/atoms/2026/04/world-cup-player-guide-2026/default/v/1780676707960/app.js'
).then((r) => r.text());

const urls = [...js.matchAll(/https?:\/\/[^\s"'<>\\]+/g)].map((m) => m[0]);
const dataish = [...new Set(urls)].filter((u) =>
  /(\.json|\.csv|\.tsv|sheets|spreadsheet|teams|players|data|atom\.guim)/i.test(u)
);
console.log('data-ish urls in app.js:');
for (const u of dataish.slice(0, 30)) console.log(' ', u);

const fetchHits = [...js.matchAll(/fetch\(['"]([^'"]+)['"]/g)];
console.log('\nfetch() calls:');
for (const m of fetchHits.slice(0, 20)) console.log(' ', m[1]);

// Look for any reference to a "data" path
const dataPaths = [...js.matchAll(/['"]\/atoms\/[^'"]+\.(json|csv|tsv)['"]/g)].map(
  (m) => m[0]
);
console.log('\nrelative data paths:', dataPaths.slice(0, 10));

// Sometimes the data is inlined. Check for likely player records.
const hasInline =
  js.includes('"jersey_number"') ||
  js.includes('"player_number"') ||
  js.includes('"team_key"');
console.log('\nhas inline player JSON?', hasInline);
