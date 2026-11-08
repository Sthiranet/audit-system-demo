'use strict';
// Kernel · hashing. Same scheme as the build plan's hashing spec (v1), simplified:
//   leaf    = H(0x00 || salt || canonical(event))
//   node    = H(0x01 || left || right)
//   root    = RFC 6962-style Merkle tree hash over the batch's leaves (empty batch: H(""))
//   head    = H(0x02 || prev_head || root || canonical(meta))
//   genesis = H(0x03 || "sthiranet/v1/genesis/" || chain)
const crypto = require('crypto');

const TAG = { LEAF: 0x00, NODE: 0x01, HEAD: 0x02, GENESIS: 0x03 };

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8'));
  return h.digest('hex');
}

const hex = (h) => Buffer.from(h, 'hex');
const tag = (t) => Buffer.from([t]);

// Canonical JSON: keys sorted, no whitespace (a stand-in for RFC 8785 JCS).
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
    .join(',') + '}';
}

const newSalt = () => crypto.randomBytes(16).toString('hex');
const leafHash = (salt, event) => sha256(tag(TAG.LEAF), hex(salt), canonical(event));
const nodeHash = (left, right) => sha256(tag(TAG.NODE), hex(left), hex(right));
const EMPTY_ROOT = sha256('');

// Returns the whole tree so the UI can draw it: { hash, left, right } or { hash, leaf: index }.
function merkleTree(leaves) {
  if (!leaves.length) return { hash: EMPTY_ROOT, empty: true };
  function build(lo, hi) {
    const n = hi - lo;
    if (n === 1) return { hash: leaves[lo], leaf: lo };
    let k = 1;
    while (k * 2 < n) k *= 2; // largest power of two below n
    const left = build(lo, lo + k);
    const right = build(lo + k, hi);
    return { hash: nodeHash(left.hash, right.hash), left, right };
  }
  return build(0, leaves.length);
}

const headHash = (prevHead, root, meta) => sha256(tag(TAG.HEAD), hex(prevHead), hex(root), canonical(meta));
const genesisHead = (chainId) => sha256(tag(TAG.GENESIS), 'sthiranet/v1/genesis/' + chainId);

module.exports = { sha256, canonical, newSalt, leafHash, nodeHash, merkleTree, headHash, genesisHead, EMPTY_ROOT };
