'use strict';
// Node layer · a subsidiary's sthira-node: captured changes wait in `pending`; seal() closes a batch,
// hashes it into a Merkle tree, chains the head, and appends an AuditAnchor on the ledger.
// The records themselves stay in this node's off-ledger audit store (`store`).
const { newSalt, leafHash, merkleTree, headHash, genesisHead } = require('../kernel/crypto');
const { FinanceSource, normalize, describe } = require('../connectors/finance-profile');

const clone = (o) => JSON.parse(JSON.stringify(o));

class SubsidiaryNode {
  constructor(cfg, ledger, chainStart) {
    Object.assign(this, { cfg, ledger, id: cfg.id, chainId: cfg.id });
    this.source = new FinanceSource(cfg);
    this.genesis = genesisHead(this.chainId);
    this.chainStart = chainStart;
    this.pending = [];
    this.store = []; // off-ledger audit store: one row per captured event
    this.batches = []; // the node's own batch table
    this.eventSeq = 0;
  }

  get lastBatch() {
    return this.batches[this.batches.length - 1];
  }

  capture(n, now = Date.now()) {
    const added = [];
    for (let i = 0; i < n; i++) {
      const raw = this.source.next(now - (n - i) * 300);
      const rec = { id: `${this.id}-${String(++this.eventSeq).padStart(5, '0')}`, raw, event: normalize(raw, this.chainId) };
      this.pending.push(rec);
      added.push(rec);
    }
    return added;
  }

  seal(now = Date.now()) {
    const events = this.pending;
    const last = this.lastBatch;
    const seq = (last ? last.seq : 0) + 1;
    const prevHead = last ? last.head : this.genesis;
    const salts = events.map(() => newSalt());
    const leaves = events.map((e, i) => leafHash(salts[i], e.event));
    const tree = merkleTree(leaves);
    const fromTime = last ? last.toTime : this.chainStart;
    const toTime = new Date(now).toISOString();
    const meta = { chain: this.chainId, seq, event_count: events.length, from_time: fromTime, to_time: toTime };
    const head = headHash(prevHead, tree.hash, meta);

    // Throws if any member's node refuses to co-sign.
    const anchor = this.ledger.append(this.chainId, this.id, {
      seq, prevHead, head, merkleRoot: tree.hash, eventCount: events.length, fromTime, toTime,
    });

    const rows = events.map((e, i) => ({
      id: e.id, chain: this.chainId, batchSeq: seq, index: i, event: e.event, raw: e.raw, salt: salts[i], leafHash: leaves[i],
    }));
    this.store.push(...rows);
    this.pending = [];
    const batch = {
      seq, prevHead, head, merkleRoot: tree.hash, eventCount: events.length, fromTime, toTime, meta, tree,
      sealedAt: toTime, contractId: anchor.contractId, updateId: anchor.updateId,
      // Snapshot of exactly what was hashed, for the "Capture & batch" view.
      items: rows.map((r) => ({ id: r.id, key: r.event.key.id, op: r.event.op, table: r.event.source.table, ...describe(r.event), salt: r.salt, leafHash: r.leafHash, event: clone(r.event) })),
    };
    this.batches.push(batch);
    return { batch, anchor };
  }
}

module.exports = { SubsidiaryNode };
