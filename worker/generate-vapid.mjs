// One-shot script to generate a VAPID public/private keypair for Web Push.
// Run once with: node generate-vapid.mjs
// Save the public key into ../app.js (VAPID_PUBLIC_KEY) and ship to the PWA.
// Save the private key as a Cloudflare Worker secret:
//   wrangler secret put VAPID_PRIVATE_KEY
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('VAPID public key  (paste into PWA app.js):');
console.log('  ' + keys.publicKey);
console.log('');
console.log('VAPID private key (set as Worker secret, never commit):');
console.log('  ' + keys.privateKey);
console.log('');
console.log('Run:  wrangler secret put VAPID_PRIVATE_KEY');
console.log('and paste the private key when prompted.');
