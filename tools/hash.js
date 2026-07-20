// Print the SHA-256 hex of a passphrase, for site/config.js (access gate).
// Usage:  node tools/hash.js "your passphrase"
const c = require('crypto');
const p = process.argv[2];
if (!p) { console.error('usage: node tools/hash.js "passphrase"'); process.exit(1); }
console.log(c.createHash('sha256').update(p).digest('hex'));
