'use strict';
// Wires the parties together and exposes the actions the UI calls.
// Everything is in memory; Reset rebuilds the network from scratch.
const { Ledger, LedgerError } = require('./kernel/ledger');
const { leafHash } = require('./kernel/crypto');
const { SubsidiaryNode } = require('./node/subsidiary');
const { verifyTrail } = require('./node/verifier');
const profile = require('./connectors/finance-profile');

// ── Cast. Rename freely (e.g. Aranya Industries, Mumbai / Singapore / Frankfurt / Dubai). ──
const HQ = { id: 'HQ', name: 'Headquarters', region: 'Region R' };
const AUDITOR = { id: 'AUDITOR', name: 'External Auditor', region: 'Independent' };
const SUBSIDIARIES = [
  { id: 'S1', name: 'Subsidiary S1', region: 'Region R1', db: 'PostgreSQL 17', connector: 'postgresql', currency: 'USD' },
  { id: 'S2', name: 'Subsidiary S2', region: 'Region R2', db: 'Oracle 26ai', connector: 'oracle', currency: 'EUR' },
  { id: 'S3', name: 'Subsidiary S3', region: 'Region R3', db: 'PostgreSQL 17', connector: 'postgresql', currency: 'AED' },
];
const SEED_BATCHES = 3;
const AUTO_INTERVAL_MS = 10000;

class DemoError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const short = (h) => (h ? h.slice(0, 8) : '');

let W = null; // the whole demo world

function log(level, actor, text) {
  W.activity.unshift({ at: new Date().toISOString(), level, actor, text });
  if (W.activity.length > 100) W.activity.length = 100;
  W.version++;
}

function reset() {
  if (W && W.autoTimer) clearInterval(W.autoTimer);
  const ledger = new Ledger();
  [HQ.id, AUDITOR.id, ...SUBSIDIARIES.map((s) => s.id)].forEach((p) => ledger.addParty(p));
  const base = Date.now() - (SEED_BATCHES + 1) * AUTO_INTERVAL_MS;
  const subs = {};
  for (const cfg of SUBSIDIARIES) {
    const node = new SubsidiaryNode(cfg, ledger, new Date(base).toISOString());
    ledger.createChain(node.chainId, node.id, [node.id, HQ.id], node.genesis);
    subs[cfg.id] = node;
  }
  W = { ledger, subs, hq: { received: {} }, auditor: { enabled: false }, auto: false, autoTimer: null, lastVerify: {}, activity: [], version: 0 };

  // A little history so the demo opens on a live network.
  for (let b = 1; b <= SEED_BATCHES; b++) {
    const t = base + b * AUTO_INTERVAL_MS;
    for (const node of Object.values(subs)) {
      node.capture(rand(5, 9), t - 2500);
      node.seal(t);
    }
  }
  for (const id of Object.keys(subs)) pushTrail(id, true);
  log('info', 'Network', `Started: HQ and ${SUBSIDIARIES.length} subsidiaries on one private synchronizer. ` +
    `${SEED_BATCHES} batches anchored per subsidiary and trails pushed to HQ.`);
  return state();
}

function sub(id) {
  const node = W.subs[id];
  if (!node) throw new DemoError(`Unknown subsidiary ${id}`, 404);
  return node;
}

function hqCopySummary(id) {
  const rec = W.hq.received[id];
  if (!rec) return null;
  const seqs = rec.rows.map((r) => r.batchSeq);
  return { pushedAt: rec.pushedAt, count: rec.rows.length, lastSeq: seqs.length ? Math.max(...seqs) : 0 };
}

function state() {
  return {
    version: W.version,
    auto: W.auto,
    auditor: { ...AUDITOR, enabled: W.auditor.enabled },
    hq: HQ,
    subs: Object.values(W.subs).map((n) => ({
      id: n.id, name: n.cfg.name, region: n.cfg.region, db: n.cfg.db, currency: n.cfg.currency,
      pending: n.pending.length,
      lastSeq: n.lastBatch ? n.lastBatch.seq : 0,
      lastHead: n.lastBatch ? n.lastBatch.head : n.genesis,
      storeCount: n.store.length,
      members: W.ledger.copy(n.id, n.chainId).members,
      hqCopy: hqCopySummary(n.id),
    })),
    lastVerify: W.lastVerify,
    activity: W.activity.slice(0, 50),
    envelopes: W.ledger.envelopes.length,
  };
}

function pendingRows(node) {
  return node.pending.map((r) => ({
    id: r.id, op: r.event.op, table: r.event.source.table, key: r.event.key.id,
    committedAt: r.event.committed_at, ...profile.describe(r.event), raw: r.raw, event: r.event,
  }));
}

function capture(id, count) {
  const node = sub(id);
  const n = Math.max(1, Math.min(20, parseInt(count, 10) || 5));
  node.capture(n);
  log('info', id, `Debezium captured ${n} change${n > 1 ? 's' : ''} from ${node.cfg.db}`);
  return { pending: pendingRows(node) };
}

function seal(id, quiet = false) {
  const node = sub(id);
  let res;
  try {
    res = node.seal();
  } catch (e) {
    if (e instanceof LedgerError) throw new DemoError(e.message, 409);
    throw e;
  }
  const { batch, anchor } = res;
  if (!quiet) {
    log('ok', id, `Sealed batch #${batch.seq}: ${batch.eventCount} event${batch.eventCount === 1 ? '' : 's'} → root ${short(batch.merkleRoot)}. ` +
      `Anchored on the ledger, co-signed by ${anchor.signatories.join(' + ')}`);
  }
  return batchDetail(id, batch.seq);
}

function batchDetail(id, seq) {
  const node = sub(id);
  const batch = node.batches.find((b) => b.seq === seq);
  if (!batch) throw new DemoError(`${id} has no batch #${seq}`, 404);
  const anchor = W.ledger.copy(id, id).anchors.find((a) => a.seq === seq);
  return { chain: id, seq, totalBatches: node.batches.length, batch, anchor };
}

function ledgerView(party) {
  if (![HQ.id, AUDITOR.id, ...Object.keys(W.subs)].includes(party)) throw new DemoError(`Unknown party ${party}`, 404);
  return {
    party,
    chains: W.ledger.view(party),
    synchronizer: W.ledger.envelopes.slice(-12).reverse(),
    totalEnvelopes: W.ledger.envelopes.length,
  };
}

function rewrite(actor, chain, seq) {
  if (![HQ.id, AUDITOR.id, ...Object.keys(W.subs)].includes(actor)) throw new DemoError(`Unknown party ${actor}`);
  sub(chain);
  let res;
  try {
    res = W.ledger.attemptArchive(chain, actor, parseInt(seq, 10));
  } catch (e) {
    if (e instanceof LedgerError) throw new DemoError(e.message);
    throw e;
  }
  log('warn', actor, res.required.length
    ? `Tried to archive AuditAnchor #${seq} on chain ${chain}. Rejected: missing signature${res.missing.length > 1 ? 's' : ''} from ${res.missing.join(' and ')}`
    : `Tried to archive an anchor on chain ${chain}. Rejected: ${actor} is not a stakeholder of that chain`);
  return res;
}

function trailRows(rows) {
  return rows.map((r) => ({
    id: r.id, batchSeq: r.batchSeq, index: r.index, op: r.event.op, table: r.event.source.table,
    key: r.event.key.id, ...profile.describe(r.event), salt: r.salt, leafHash: r.leafHash, event: r.event,
  }));
}

function trail(where, chain) {
  const node = sub(chain);
  if (where === 'sub') {
    return { where, chain, holder: chain, location: node.cfg.region, rows: trailRows(node.store) };
  }
  if (where === 'hq') {
    const rec = W.hq.received[chain];
    return { where, chain, holder: HQ.id, location: HQ.region, pushedAt: rec ? rec.pushedAt : null, rows: rec ? trailRows(rec.rows) : [] };
  }
  throw new DemoError('where must be "sub" or "hq"');
}

function pushTrail(chain, quiet = false) {
  const node = sub(chain);
  W.hq.received[chain] = { pushedAt: new Date().toISOString(), rows: clone(node.store) };
  const batches = new Set(node.store.map((r) => r.batchSeq)).size;
  if (!quiet) log('info', chain, `Pushed its audit trail upstream to HQ: ${node.store.length} events across ${batches} batches`);
  return { ok: true, ...hqCopySummary(chain) };
}

function tamper({ where, chain, eventId, mode, cover }) {
  const node = sub(chain);
  let rows;
  if (where === 'sub') rows = node.store;
  else if (where === 'hq') {
    if (!W.hq.received[chain]) throw new DemoError(`HQ holds no trail from ${chain} yet`);
    rows = W.hq.received[chain].rows;
  } else throw new DemoError('where must be "sub" or "hq"');

  const idx = rows.findIndex((r) => r.id === eventId);
  if (idx < 0) throw new DemoError(`No event ${eventId} in that trail`, 404);
  const row = rows[idx];
  const who = where === 'hq' ? 'HQ' : chain;
  const place = where === 'hq' ? `HQ's copy of ${chain}'s trail` : `${chain}'s audit store`;
  let description;
  if (mode === 'delete') {
    description = `deleted ${row.id} (${profile.describe(row.event).text})`;
    rows.splice(idx, 1);
  } else {
    description = profile.tamper(row.event);
    if (cover) row.leafHash = leafHash(row.salt, row.event);
  }
  log('danger', who, `Someone altered ${place} after it was anchored: ${description}` +
    (cover ? '. The stored leaf hash was recomputed to cover the tracks.' : ''));
  return { ok: true, description };
}

function verify(verifier, chain) {
  if (![HQ.id, AUDITOR.id].includes(verifier)) throw new DemoError('Verifier must be HQ or AUDITOR');
  if (verifier === AUDITOR.id && !W.auditor.enabled) throw new DemoError('Add the auditor to the network first');
  sub(chain);
  const rec = W.hq.received[chain];
  if (!rec) throw new DemoError(`HQ holds no trail from ${chain}. Push it first.`);
  const copy = W.ledger.copy(verifier, chain);
  const res = verifyTrail({ chainId: chain, genesisHead: copy.genesisHead, anchors: copy.anchors, rows: rec.rows });
  W.lastVerify[chain] = { verifier, ok: res.ok, at: new Date().toISOString(), failedSeqs: res.failedSeqs, firstBadSeq: res.firstBadSeq };
  const who = verifier === 'HQ' ? 'HQ' : 'Auditor';
  if (res.ok) {
    log('ok', verifier, `${who} verified ${chain}'s trail: all ${res.batches.length} batches match the anchors on its own ledger copy`);
  } else {
    log('danger', verifier, `${who} verified ${chain}'s trail: batch #${res.firstBadSeq} does not match its anchor. ` +
      `${res.failedSeqs.length} batch${res.failedSeqs.length > 1 ? 'es' : ''} fail. The trail was altered after capture.`);
  }
  return { ...res, verifier, chain, trailPushedAt: rec.pushedAt, anchorsCount: copy.anchors.length, members: copy.members };
}

function addAuditor() {
  if (W.auditor.enabled) return state();
  for (const id of Object.keys(W.subs)) W.ledger.addMember(id, AUDITOR.id, id);
  W.auditor.enabled = true;
  log('ok', 'AUDITOR', 'Joined the network. Every member signed its admission. Its node now holds a copy of every chain, ' +
    'and every new anchor is co-signed by the subsidiary, HQ and the auditor');
  return state();
}

function autoTick() {
  const done = [];
  for (const node of Object.values(W.subs)) {
    node.capture(rand(1, 4));
    done.push(`${node.id} #${seal(node.id, true).seq}`);
  }
  log('ok', 'Network', `Auto-anchor: ${done.join(', ')}`);
}

function setAuto(on) {
  if (on && !W.auto) {
    W.autoTimer = setInterval(() => { try { autoTick(); } catch (e) { log('warn', 'Network', e.message); } }, AUTO_INTERVAL_MS);
    W.auto = true;
    log('info', 'Network', 'Auto-anchor on: each subsidiary captures changes and seals a batch every 10 seconds');
  } else if (!on && W.auto) {
    clearInterval(W.autoTimer);
    W.autoTimer = null;
    W.auto = false;
    log('info', 'Network', 'Auto-anchor off');
  }
  return state();
}

module.exports = {
  DemoError, reset, state, capture, seal, batchDetail, ledgerView, rewrite, trail, tamper, verify, addAuditor, setAuto,
  pending: (id) => ({ pending: pendingRows(sub(id)) }),
  push: (chain) => pushTrail(chain),
};
