// Scrape The Guardian's WC 2026 player guide once and emit photos.json.
//
//   node scripts/fetch-photos.mjs > photos.json
//
// Structure:
//   {
//     "Czechia": {
//       "1": { "name": "Matej Kovar", "position": "Goalkeeper", "photo": "..." },
//       "2": { ... },
//       ...
//     },
//     ...
//   }
import fs from 'node:fs/promises';

const MASTER = 'https://interactive.guim.co.uk/docsdata/1_ZAfmUkTZ4BvDgvhEGaEruakfu4aWIIjjzXaMAiT1yc.json';
const TEAM_URL = (id) => `https://interactive.guim.co.uk/docsdata/${id}.json`;

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (wc2026 photo scraper)' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

const master = await getJson(MASTER);
const teams = master.sheets.Teams;
console.error(`Found ${teams.length} teams.`);

const out = {};
let nPlayers = 0;
let nWithPhoto = 0;

for (const t of teams) {
  if (!t.spreadsheet) continue;
  let team;
  try {
    team = await getJson(TEAM_URL(t.spreadsheet));
  } catch (e) {
    console.error(`!! ${t.Team}: ${e.message}`);
    continue;
  }
  const players = team.sheets?.Players || [];
  const byNumber = {};
  for (const p of players) {
    const num = String(p.number ?? '').trim();
    if (!num) continue;
    nPlayers++;
    if (p.grid_image) nWithPhoto++;
    byNumber[num] = {
      name: p.name?.trim() || '',
      position: p.position?.trim() || '',
      photo: p.grid_image?.trim() || '',
    };
  }
  out[t.Team] = byNumber;
  console.error(`  ${t.Team}: ${Object.keys(byNumber).length} players`);
}

console.error(`\nTotal: ${nPlayers} players, ${nWithPhoto} with photos.`);

const outPath = new URL('../photos.json', import.meta.url);
await fs.writeFile(outPath, JSON.stringify(out));
console.error(`Wrote ${outPath.pathname}`);
