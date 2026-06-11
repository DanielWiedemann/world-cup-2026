// One-shot script to generate a VAPID public/private keypair for Web Push.
// Run with: node generate-vapid.mjs
//
// Uses pure Web Crypto (works in modern Node + Cloudflare Workers + browsers).
// Outputs base64url-encoded keys you can paste into wrangler.toml (public)
// and `wrangler secret put VAPID_PRIVATE_KEY` (private).

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
const privJwk = await crypto.subtle.exportKey('jwk', privateKey);

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const publicB64 = b64url(pubRaw);
const privateB64 = privJwk.d; // already base64url in JWK form

console.log('VAPID public key  (paste into wrangler.toml VAPID_PUBLIC_KEY + ../app.js VAPID_PUBLIC_KEY):');
console.log('  ' + publicB64);
console.log('');
console.log('VAPID private key (set as Worker secret, never commit):');
console.log('  ' + privateB64);
console.log('');
console.log('Run:  wrangler secret put VAPID_PRIVATE_KEY');
console.log('and paste the private key when prompted.');
