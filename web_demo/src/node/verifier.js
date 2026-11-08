'use strict';
// Node layer · sthira-verify. Any member (HQ, the auditor) takes an off-ledger audit trail,
// recomputes every leaf, Merkle root and head, and compares them with the anchors stored on
// ITS OWN ledger copy. It needs nothing from the party that produced the trail except the trail.
const { leafHash, merkleTree, headHash } = require('../kernel/crypto');
const { describe } = require('../connectors/finance-profile');

function verifyTrail({ chainId, genesisHead, anchors, rows }) {
  const bySeq = new Map();
  for (const r of rows) {
    if (!bySeq.has(r.batchSeq)) bySeq.set(r.batchSeq, []);
    bySeq.get(r.batchSeq).push(r);
  }

  let prevHead = genesisHead;
  const batches = [];
  for (const a of anchors) {
    const evs = (bySeq.get(a.seq) || []).slice().sort((x, y) => x.index - y.index);
    const leaves = evs.map((r) => leafHash(r.salt, r.event));
    const tree = merkleTree(leaves);
    const meta = { chain: chainId, seq: a.seq, event_count: evs.length, from_time: a.fromTime, to_time: a.toTime };
    const head = headHash(prevHead, tree.hash, meta);

    // Leaves that no longer hash to the value recorded when the event was captured.
    const leafIssues = [];
    evs.forEach((r, i) => {
      if (leaves[i] !== r.leafHash) leafIssues.push({ index: i, eventId: r.id, key: r.event.key.id, recorded: r.leafHash, recomputed: leaves[i] });
    });
    const missingIndexes = [];
    for (let i = 0; i < a.eventCount; i++) if (!evs.some((r) => r.index === i)) missingIndexes.push(i);

    const rootMatch = tree.hash === a.merkleRoot;
    const headMatch = head === a.head;
    const countMatch = evs.length === a.eventCount;
    batches.push({
      seq: a.seq,
      ok: rootMatch && headMatch && countMatch,
      rootMatch, headMatch, countMatch,
      anchored: { root: a.merkleRoot, head: a.head, prevHead: a.prevHead, eventCount: a.eventCount, fromTime: a.fromTime, toTime: a.toTime, signatories: a.signatories, contractId: a.contractId },
      recomputed: { root: tree.hash, head, prevHead, eventCount: evs.length },
      leafIssues, missingIndexes, tree,
      leaves: evs.map((r, i) => ({ id: r.id, key: r.event.key.id, index: r.index, leaf: leaves[i], ...describe(r.event) })),
    });
    prevHead = head; // heads chain: one altered batch breaks every head after it
  }

  const anchored = new Set(anchors.map((a) => a.seq));
  const unanchored = [...bySeq.keys()].filter((s) => !anchored.has(s));
  const failedSeqs = batches.filter((b) => !b.ok).map((b) => b.seq);
  const firstRootMismatch = batches.find((b) => !b.rootMatch || !b.countMatch);
  return {
    ok: failedSeqs.length === 0 && unanchored.length === 0,
    batches, failedSeqs, unanchored,
    firstBadSeq: firstRootMismatch ? firstRootMismatch.seq : null,
    eventCount: rows.length,
  };
}

module.exports = { verifyTrail };
