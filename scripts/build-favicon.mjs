// Build a multi-resolution favicon.ico from PNG sources (16/32/48), reading
// base64 from favicon-src.json. Modern browsers support PNG-encoded ICO
// entries, so we embed the PNGs directly — same artwork as the app icons.
//
//   node scripts/build-favicon.mjs   (expects scripts/favicon-src.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(fs.readFileSync(path.join(dir, 'favicon-src.json'), 'utf8'));
const sizes = [16, 32, 48];
const pngs = sizes.map((s) => ({ size: s, buf: Buffer.from(src[s], 'base64') }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

let offset = 6 + pngs.length * 16;
const entries = [];
for (const { size, buf } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(buf.length, 8); // size of PNG data
  e.writeUInt32LE(offset, 12); // offset to PNG data
  offset += buf.length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
const out = path.join(dir, '..', 'favicon.ico');
fs.writeFileSync(out, ico);
console.log(`Wrote ${out} (${ico.length} bytes, sizes: ${sizes.join('/')})`);
