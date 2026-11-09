//! Node layer · sthira-verify. Any member (HQ, the auditor) takes an off-ledger audit trail,
//! recomputes every leaf, Merkle root and head, and compares them with the anchors stored on
//! ITS OWN ledger copy. It needs nothing from the party that produced the trail except the trail.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sthira_batcher::StoreRow;
use sthira_core::{BatchMeta, MerkleTree, head_hash, leaf_hash, merkle_tree};
use sthira_ledger::Anchor;
use sthira_profiles::{Description, describe};

/// A leaf that no longer hashes to the value recorded when the event was captured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LeafIssue {
    pub index: usize,
    pub event_id: String,
    pub key: String,
    pub recorded: String,
    pub recomputed: String,
}

/// The values committed on the ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnchoredValues {
    pub root: String,
    pub head: String,
    pub prev_head: String,
    pub event_count: u64,
    pub from_time: String,
    pub to_time: String,
    pub signatories: Vec<String>,
    pub contract_id: String,
}

/// The values recomputed from the trail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecomputedValues {
    pub root: String,
    pub head: String,
    pub prev_head: String,
    pub event_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LeafView {
    pub id: String,
    pub key: String,
    pub index: usize,
    pub leaf: String,
    #[serde(flatten)]
    pub description: Description,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BatchCheck {
    pub seq: u64,
    pub ok: bool,
    pub root_match: bool,
    pub head_match: bool,
    pub count_match: bool,
    pub anchored: AnchoredValues,
    pub recomputed: RecomputedValues,
    pub leaf_issues: Vec<LeafIssue>,
    pub missing_indexes: Vec<usize>,
    pub tree: MerkleTree,
    pub leaves: Vec<LeafView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub ok: bool,
    pub batches: Vec<BatchCheck>,
    /// Batches whose root, head or count does not match.
    pub failed_seqs: Vec<u64>,
    /// Batch numbers present in the trail with no anchor on the ledger.
    pub unanchored: Vec<u64>,
    /// The first batch whose own contents changed (root or count mismatch).
    pub first_bad_seq: Option<u64>,
    pub event_count: usize,
}

/// Recomputes the trail `rows` of chain `chain_id` and compares it with `anchors`, which must come
/// from the verifier's own ledger copy.
pub fn verify_trail(chain_id: &str, genesis_head: &str, anchors: &[Anchor], rows: &[StoreRow]) -> VerifyReport {
    let mut by_seq: BTreeMap<u64, Vec<&StoreRow>> = BTreeMap::new();
    for r in rows {
        by_seq.entry(r.batch_seq).or_default().push(r);
    }

    let mut prev_head = genesis_head.to_string();
    let mut batches = Vec::with_capacity(anchors.len());
    for a in anchors {
        let mut evs: Vec<&StoreRow> = by_seq.get(&a.seq).cloned().unwrap_or_default();
        evs.sort_by_key(|r| r.index);
        let leaves: Vec<String> = evs.iter().map(|r| leaf_hash(&r.salt, &r.event)).collect();
        let tree = merkle_tree(&leaves);
        let meta = BatchMeta {
            chain: chain_id.to_string(),
            seq: a.seq,
            from_pos: a.from_pos.clone(),
            to_pos: a.to_pos.clone(),
            from_time: a.from_time.clone(),
            to_time: a.to_time.clone(),
            event_count: evs.len() as u64,
        };
        let head = head_hash(&prev_head, &tree.hash, &meta);

        let leaf_issues = evs
            .iter()
            .zip(&leaves)
            .enumerate()
            .filter(|(_, (r, l))| r.leaf_hash != **l)
            .map(|(i, (r, l))| LeafIssue {
                index: i,
                event_id: r.id.clone(),
                key: r.event.key.id.clone(),
                recorded: r.leaf_hash.clone(),
                recomputed: l.clone(),
            })
            .collect();
        let present: BTreeSet<usize> = evs.iter().map(|r| r.index).collect();
        let missing_indexes = (0..a.event_count as usize).filter(|i| !present.contains(i)).collect();

        let root_match = tree.hash == a.merkle_root;
        let head_match = head == a.head;
        let count_match = evs.len() as u64 == a.event_count;
        batches.push(BatchCheck {
            seq: a.seq,
            ok: root_match && head_match && count_match,
            root_match,
            head_match,
            count_match,
            anchored: AnchoredValues {
                root: a.merkle_root.clone(),
                head: a.head.clone(),
                prev_head: a.prev_head.clone(),
                event_count: a.event_count,
                from_time: a.from_time.clone(),
                to_time: a.to_time.clone(),
                signatories: a.signatories.clone(),
                contract_id: a.contract_id.clone(),
            },
            recomputed: RecomputedValues {
                root: tree.hash.clone(),
                head: head.clone(),
                prev_head: prev_head.clone(),
                event_count: evs.len() as u64,
            },
            leaf_issues,
            missing_indexes,
            leaves: evs
                .iter()
                .zip(&leaves)
                .map(|(r, l)| LeafView {
                    id: r.id.clone(),
                    key: r.event.key.id.clone(),
                    index: r.index,
                    leaf: l.clone(),
                    description: describe(&r.event),
                })
                .collect(),
            tree,
        });
        prev_head = head; // heads chain: one altered batch breaks every head after it
    }

    let anchored: BTreeSet<u64> = anchors.iter().map(|a| a.seq).collect();
    let unanchored: Vec<u64> = by_seq.keys().copied().filter(|s| !anchored.contains(s)).collect();
    let failed_seqs: Vec<u64> = batches.iter().filter(|b| !b.ok).map(|b| b.seq).collect();
    let first_bad_seq = batches.iter().find(|b| !b.root_match || !b.count_match).map(|b| b.seq);
    VerifyReport {
        ok: failed_seqs.is_empty() && unanchored.is_empty(),
        batches,
        failed_seqs,
        unanchored,
        first_bad_seq,
        event_count: rows.len(),
    }
}
