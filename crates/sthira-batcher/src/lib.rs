//! Node layer · a subsidiary's sthira-node. Captured changes wait in `pending`; [`SubsidiaryNode::seal`]
//! closes a batch, hashes it into a Merkle tree, chains the head, and appends an `AuditAnchor` on the
//! ledger. The records themselves stay in this node's off-ledger audit store (`store`).
//!
//! An empty batch is sealed and anchored too, so a quiet period is visible on the ledger.

use serde::{Deserialize, Serialize};
use sthira_core::{BatchMeta, Event, MerkleTree, Op, genesis_head, head_hash, leaf_hash, merkle_tree, new_salt};
use sthira_ledger::{Anchor, AnchorInput, AuditLedger, LedgerError};
use sthira_profiles::{DebeziumEvent, Description, FinanceSource, SourceConfig, describe, iso_micros, normalize};

/// A captured change waiting for the next batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRecord {
    pub id: String,
    pub raw: DebeziumEvent,
    pub event: Event,
}

/// One row of the off-ledger audit store: the event, its salt and the leaf hash recorded at capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StoreRow {
    pub id: String,
    pub chain: String,
    pub batch_seq: u64,
    pub index: usize,
    pub event: Event,
    pub raw: DebeziumEvent,
    pub salt: String,
    pub leaf_hash: String,
}

/// What was hashed for one leaf, for the "Capture & batch" view.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub id: String,
    pub key: String,
    pub op: Op,
    pub table: String,
    #[serde(flatten)]
    pub description: Description,
    pub salt: String,
    pub leaf_hash: String,
    pub event: Event,
}

/// A row of the node's own batch table.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub seq: u64,
    pub prev_head: String,
    pub head: String,
    pub merkle_root: String,
    pub event_count: u64,
    pub from_time: String,
    pub to_time: String,
    pub from_pos: String,
    pub to_pos: String,
    pub meta: BatchMeta,
    pub tree: MerkleTree,
    pub sealed_at: String,
    pub contract_id: String,
    pub update_id: String,
    pub items: Vec<BatchItem>,
}

pub struct SubsidiaryNode {
    pub id: String,
    pub chain_id: String,
    pub genesis: String,
    pub chain_start: String,
    pub source: FinanceSource,
    pub pending: Vec<PendingRecord>,
    /// Off-ledger audit store: one row per captured event.
    pub store: Vec<StoreRow>,
    /// The node's own batch table.
    pub batches: Vec<Batch>,
    event_seq: u64,
}

impl SubsidiaryNode {
    /// A node whose chain id is its party id. `chain_start` is the start of the first batch window.
    pub fn new(cfg: SourceConfig, chain_start: String) -> Self {
        Self::with_source(cfg.id.clone(), FinanceSource::new(cfg), chain_start)
    }

    pub fn with_source(id: String, source: FinanceSource, chain_start: String) -> Self {
        Self {
            genesis: genesis_head(&id),
            chain_id: id.clone(),
            id,
            chain_start,
            source,
            pending: Vec::new(),
            store: Vec::new(),
            batches: Vec::new(),
            event_seq: 0,
        }
    }

    pub fn last_batch(&self) -> Option<&Batch> {
        self.batches.last()
    }

    pub fn last_seq(&self) -> u64 {
        self.last_batch().map_or(0, |b| b.seq)
    }

    pub fn last_head(&self) -> &str {
        self.last_batch().map_or(&self.genesis, |b| &b.head)
    }

    pub fn batch(&self, seq: u64) -> Option<&Batch> {
        self.batches.iter().find(|b| b.seq == seq)
    }

    /// Captures `n` changes from the source, spaced 300 ms apart and ending at `now_ms`.
    pub fn capture(&mut self, n: usize, now_ms: i64) -> &[PendingRecord] {
        let start = self.pending.len();
        for i in 0..n {
            let raw = self.source.next(now_ms - (n - i) as i64 * 300);
            self.event_seq += 1;
            let event = normalize(&raw, &self.chain_id);
            self.pending.push(PendingRecord { id: format!("{}-{:05}", self.id, self.event_seq), raw, event });
        }
        &self.pending[start..]
    }

    /// Seals every pending change into the next batch and anchors it. Fails without changing
    /// anything if any member's node refuses to co-sign.
    pub fn seal(&mut self, ledger: &mut dyn AuditLedger, now_ms: i64) -> Result<(&Batch, Anchor), LedgerError> {
        let last = self.last_batch();
        let seq = last.map_or(0, |b| b.seq) + 1;
        let prev_head = last.map_or_else(|| self.genesis.clone(), |b| b.head.clone());
        let from_time = last.map_or_else(|| self.chain_start.clone(), |b| b.to_time.clone());
        let prev_pos = last.map(|b| b.to_pos.clone()).unwrap_or_default();
        let to_time = iso_micros(now_ms);

        let events = &self.pending;
        let salts: Vec<String> = events.iter().map(|_| new_salt()).collect();
        let leaves: Vec<String> = events.iter().zip(&salts).map(|(e, s)| leaf_hash(s, &e.event)).collect();
        let tree = merkle_tree(&leaves);
        let from_pos = events.first().map_or_else(|| prev_pos.clone(), |e| e.event.source.pos.clone());
        let to_pos = events.last().map_or(prev_pos, |e| e.event.source.pos.clone());
        let meta = BatchMeta {
            chain: self.chain_id.clone(),
            seq,
            from_pos: from_pos.clone(),
            to_pos: to_pos.clone(),
            from_time: from_time.clone(),
            to_time: to_time.clone(),
            event_count: events.len() as u64,
        };
        let head = head_hash(&prev_head, &tree.hash, &meta);

        let anchor = ledger.append(
            &self.chain_id,
            &self.id,
            AnchorInput {
                seq,
                prev_head: prev_head.clone(),
                head: head.clone(),
                merkle_root: tree.hash.clone(),
                event_count: events.len() as u64,
                from_pos: from_pos.clone(),
                to_pos: to_pos.clone(),
                from_time: from_time.clone(),
                to_time: to_time.clone(),
            },
        )?;

        let pending = std::mem::take(&mut self.pending);
        let mut items = Vec::with_capacity(pending.len());
        for (i, ((rec, salt), leaf)) in pending.into_iter().zip(salts).zip(leaves).enumerate() {
            items.push(BatchItem {
                id: rec.id.clone(),
                key: rec.event.key.id.clone(),
                op: rec.event.op,
                table: rec.event.source.table.clone(),
                description: describe(&rec.event),
                salt: salt.clone(),
                leaf_hash: leaf.clone(),
                event: rec.event.clone(),
            });
            self.store.push(StoreRow {
                id: rec.id,
                chain: self.chain_id.clone(),
                batch_seq: seq,
                index: i,
                event: rec.event,
                raw: rec.raw,
                salt,
                leaf_hash: leaf,
            });
        }
        self.batches.push(Batch {
            seq,
            prev_head,
            head,
            merkle_root: tree.hash.clone(),
            event_count: meta.event_count,
            from_time,
            to_time: to_time.clone(),
            from_pos,
            to_pos,
            meta,
            tree,
            sealed_at: to_time,
            contract_id: anchor.contract_id.clone(),
            update_id: anchor.update_id.clone(),
            items,
        });
        Ok((self.batches.last().expect("just pushed"), anchor))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthira_ledger::SimLedger;

    #[test]
    fn seal_anchors_and_chains() {
        let mut ledger = SimLedger::new();
        ledger.add_party("S1");
        ledger.add_party("HQ");
        let cfg = SourceConfig { id: "S1".into(), connector: "postgresql".into(), currency: "USD".into() };
        let mut node = SubsidiaryNode::with_source("S1".into(), FinanceSource::with_seed(cfg, 1), iso_micros(0));
        ledger.create_chain("S1", "S1", &["S1".into(), "HQ".into()], &node.genesis).unwrap();

        node.capture(10, 10_000);
        let genesis = node.genesis.clone();
        let (b1, a1) = node.seal(&mut ledger, 10_000).unwrap();
        assert_eq!((b1.seq, b1.event_count, b1.items.len()), (1, 10, 10));
        assert_eq!(a1.merkle_root, b1.merkle_root);
        assert_eq!(a1.prev_head, genesis);
        let h1 = b1.head.clone();

        let (b2, a2) = node.seal(&mut ledger, 20_000).unwrap(); // empty batch
        assert_eq!(b2.event_count, 0);
        assert_eq!(a2.prev_head, h1);
        assert_eq!(b2.from_pos, b2.to_pos);
        assert_eq!(node.store.len(), 10);
        assert!(node.pending.is_empty());
        assert_eq!(ledger.copy("HQ", "S1").unwrap().last_seq, 2);
    }
}
