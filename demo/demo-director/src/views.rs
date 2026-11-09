//! JSON shapes the UI reads (camelCase). These are the contract the TypeScript client is generated from.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sthira_batcher::Batch;
use sthira_core::{Event, Op};
use sthira_ledger::{Anchor, ChainCopy, Envelope, Party};
use sthira_profiles::{DebeziumEvent, Description};
use sthira_verify::VerifyReport;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PartyView {
    pub id: String,
    pub name: String,
    pub region: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AuditorView {
    pub id: String,
    pub name: String,
    pub region: String,
    pub enabled: bool,
}

/// Summary of the trail copy HQ holds for one subsidiary.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HqCopy {
    pub pushed_at: String,
    pub count: usize,
    pub last_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubView {
    pub id: String,
    pub name: String,
    pub region: String,
    pub db: String,
    pub currency: String,
    /// Number of captured changes waiting for the next batch.
    pub pending: usize,
    pub last_seq: u64,
    pub last_head: String,
    pub store_count: usize,
    pub members: Vec<Party>,
    pub hq_copy: Option<HqCopy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LastVerify {
    pub verifier: Party,
    pub ok: bool,
    pub at: String,
    pub failed_seqs: Vec<u64>,
    pub first_bad_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Ok,
    Warn,
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Activity {
    pub at: String,
    pub level: Level,
    pub actor: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    /// Increments on every logged change; the UI refetches when it moves.
    pub version: u64,
    pub auto: bool,
    pub auditor: AuditorView,
    pub hq: PartyView,
    pub subs: Vec<SubView>,
    /// Last verification result per chain.
    pub last_verify: BTreeMap<String, LastVerify>,
    pub activity: Vec<Activity>,
    /// Number of envelopes the synchronizer has sequenced.
    pub envelopes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingRow {
    pub id: String,
    pub op: Op,
    pub table: String,
    pub key: String,
    pub committed_at: String,
    #[serde(flatten)]
    pub description: Description,
    pub raw: DebeziumEvent,
    pub event: Event,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PendingView {
    pub pending: Vec<PendingRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BatchDetail {
    pub chain: String,
    pub seq: u64,
    pub total_batches: usize,
    pub batch: Batch,
    pub anchor: Anchor,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LedgerView {
    pub party: Party,
    /// The chains stored on this party's node.
    pub chains: Vec<ChainCopy>,
    /// The synchronizer's most recent envelopes, newest first.
    pub synchronizer: Vec<Envelope>,
    pub total_envelopes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrailRowView {
    pub id: String,
    pub batch_seq: u64,
    pub index: usize,
    pub op: Op,
    pub table: String,
    pub key: String,
    #[serde(flatten)]
    pub description: Description,
    pub salt: String,
    pub leaf_hash: String,
    pub event: Event,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum TrailHolder {
    /// The subsidiary's own audit store.
    Sub,
    /// The copy the subsidiary pushed to HQ.
    Hq,
}

impl TrailHolder {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sub" => Some(Self::Sub),
            "hq" => Some(Self::Hq),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrailView {
    #[serde(rename = "where")]
    pub held_in: TrailHolder,
    pub chain: String,
    pub holder: Party,
    pub location: String,
    pub pushed_at: Option<String>,
    pub rows: Vec<TrailRowView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub ok: bool,
    pub pushed_at: String,
    pub count: usize,
    pub last_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TamperResult {
    pub ok: bool,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResponse {
    #[serde(flatten)]
    pub report: VerifyReport,
    pub verifier: Party,
    pub chain: String,
    pub trail_pushed_at: String,
    pub anchors_count: usize,
    pub members: Vec<Party>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

// ── Request bodies. Missing fields fall back to defaults; the actions validate them. ──

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct CaptureRequest {
    /// Number of changes to capture (1–20, default 5).
    pub count: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct RewriteRequest {
    pub actor: String,
    pub chain: String,
    pub seq: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum TamperMode {
    #[default]
    Edit,
    Delete,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct TamperRequest {
    /// `sub` or `hq`.
    #[serde(rename = "where")]
    pub held_in: String,
    pub chain: String,
    pub event_id: String,
    pub mode: TamperMode,
    /// Also recompute the stored leaf hash, to cover tracks.
    pub cover: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct VerifyRequest {
    pub verifier: String,
    pub chain: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct AutoRequest {
    pub on: bool,
}
