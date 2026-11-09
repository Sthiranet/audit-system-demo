//! The demo world: every party, in memory, and the actions the presenter triggers.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rand::Rng;
use sthira_batcher::{StoreRow, SubsidiaryNode};
use sthira_core::leaf_hash;
use sthira_ledger::{ArchiveAttempt, AuditLedger, SimLedger};
use sthira_profiles::{SourceConfig, describe, iso_micros, now_iso};
use sthira_verify::verify_trail;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::views::*;

// ── Cast. Rename freely (e.g. Aranya Industries, Mumbai / Singapore / Frankfurt / Dubai). ──
pub struct Member {
    pub id: &'static str,
    pub name: &'static str,
    pub region: &'static str,
}

pub struct SubsidiaryCfg {
    pub id: &'static str,
    pub name: &'static str,
    pub region: &'static str,
    pub db: &'static str,
    pub connector: &'static str,
    pub currency: &'static str,
}

pub const HQ: Member = Member { id: "HQ", name: "Headquarters", region: "Region R" };
pub const AUDITOR: Member = Member { id: "AUDITOR", name: "External Auditor", region: "Independent" };
pub const SUBSIDIARIES: [SubsidiaryCfg; 3] = [
    SubsidiaryCfg {
        id: "S1",
        name: "Subsidiary S1",
        region: "Region R1",
        db: "PostgreSQL 17",
        connector: "postgresql",
        currency: "USD",
    },
    SubsidiaryCfg {
        id: "S2",
        name: "Subsidiary S2",
        region: "Region R2",
        db: "Oracle 26ai",
        connector: "oracle",
        currency: "EUR",
    },
    SubsidiaryCfg {
        id: "S3",
        name: "Subsidiary S3",
        region: "Region R3",
        db: "PostgreSQL 17",
        connector: "postgresql",
        currency: "AED",
    },
];
pub const SEED_BATCHES: i64 = 3;
pub const AUTO_INTERVAL: Duration = Duration::from_secs(10);
const ACTIVITY_KEPT: usize = 100;
const ACTIVITY_SHOWN: usize = 50;
const SYNC_SHOWN: usize = 12;

/// An error the UI shows to the presenter, with its HTTP status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoError {
    pub status: u16,
    pub message: String,
}

impl DemoError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self { status: 400, message: msg.into() }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { status: 404, message: msg.into() }
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self { status: 409, message: msg.into() }
    }
}

impl std::fmt::Display for DemoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DemoError {}

pub type Result<T> = std::result::Result<T, DemoError>;

struct Sub {
    cfg: &'static SubsidiaryCfg,
    node: SubsidiaryNode,
}

struct Received {
    pushed_at: String,
    rows: Vec<StoreRow>,
}

pub type Shared = Arc<Mutex<World>>;

pub struct World {
    ledger: Box<dyn AuditLedger>,
    subs: Vec<Sub>,
    /// Trails each subsidiary has pushed upstream to HQ.
    hq_received: HashMap<String, Received>,
    auditor_enabled: bool,
    auto_task: Option<JoinHandle<()>>,
    last_verify: BTreeMap<String, LastVerify>,
    activity: VecDeque<Activity>,
    version: u64,
    version_tx: watch::Sender<u64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn short(h: &str) -> &str {
    &h[..h.len().min(8)]
}

fn plural(n: usize, w: &str) -> String {
    format!("{n} {w}{}", if n == 1 { "" } else { "s" })
}

fn party_label(p: &str) -> &str {
    if p == AUDITOR.id { "Auditor" } else { p }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    /// A freshly seeded network.
    pub fn new() -> Self {
        let (version_tx, _) = watch::channel(0);
        let mut w = Self {
            ledger: Box::new(SimLedger::new()),
            subs: Vec::new(),
            hq_received: HashMap::new(),
            auditor_enabled: false,
            auto_task: None,
            last_verify: BTreeMap::new(),
            activity: VecDeque::new(),
            version: 0,
            version_tx,
        };
        w.reset();
        w
    }

    pub fn shared() -> Shared {
        Arc::new(Mutex::new(Self::new()))
    }

    /// Notified with the new version whenever something is logged.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.version_tx.subscribe()
    }

    fn log(&mut self, level: Level, actor: &str, text: impl Into<String>) {
        self.activity.push_front(Activity { at: now_iso(), level, actor: actor.to_string(), text: text.into() });
        self.activity.truncate(ACTIVITY_KEPT);
        self.version += 1;
        self.version_tx.send_replace(self.version);
    }

    /// Rebuilds the network: HQ, the subsidiaries and the (disabled) auditor, with a few batches
    /// already anchored and every trail already pushed to HQ. The version keeps counting up.
    pub fn reset(&mut self) -> StateView {
        if let Some(t) = self.auto_task.take() {
            t.abort();
        }
        let mut ledger: Box<dyn AuditLedger> = Box::new(SimLedger::new());
        for p in [HQ.id, AUDITOR.id].into_iter().chain(SUBSIDIARIES.iter().map(|s| s.id)) {
            ledger.add_party(p);
        }
        let interval = AUTO_INTERVAL.as_millis() as i64;
        let base = now_ms() - (SEED_BATCHES + 1) * interval;
        let mut subs = Vec::new();
        for cfg in &SUBSIDIARIES {
            let src =
                SourceConfig { id: cfg.id.into(), connector: cfg.connector.into(), currency: cfg.currency.into() };
            let node = SubsidiaryNode::new(src, iso_micros(base));
            ledger
                .create_chain(&node.chain_id, &node.id, &[node.id.clone(), HQ.id.to_string()], &node.genesis)
                .expect("parties exist");
            subs.push(Sub { cfg, node });
        }
        // A little history so the demo opens on a live network.
        let mut rng = rand::rng();
        for b in 1..=SEED_BATCHES {
            let t = base + b * interval;
            for s in &mut subs {
                s.node.capture(rng.random_range(5..=9), t - 2500);
                s.node.seal(ledger.as_mut(), t).expect("fresh chain accepts the next batch");
            }
        }
        self.ledger = ledger;
        self.subs = subs;
        self.hq_received.clear();
        self.auditor_enabled = false;
        self.last_verify.clear();
        self.activity.clear();
        let ids: Vec<String> = self.subs.iter().map(|s| s.node.id.clone()).collect();
        for id in &ids {
            self.push_trail(id, true).expect("known subsidiary");
        }
        self.log(
            Level::Info,
            "Network",
            format!(
                "Started: HQ and {} subsidiaries on one private synchronizer. {SEED_BATCHES} batches anchored per subsidiary and trails pushed to HQ.",
                SUBSIDIARIES.len()
            ),
        );
        self.state()
    }

    fn sub(&self, id: &str) -> Result<&Sub> {
        self.subs
            .iter()
            .find(|s| s.node.id == id)
            .ok_or_else(|| DemoError::not_found(format!("Unknown subsidiary {id}")))
    }

    fn sub_mut(&mut self, id: &str) -> Result<&mut Sub> {
        self.subs
            .iter_mut()
            .find(|s| s.node.id == id)
            .ok_or_else(|| DemoError::not_found(format!("Unknown subsidiary {id}")))
    }

    fn is_party(&self, p: &str) -> bool {
        p == HQ.id || p == AUDITOR.id || self.subs.iter().any(|s| s.node.id == p)
    }

    fn hq_copy(&self, id: &str) -> Option<HqCopy> {
        let rec = self.hq_received.get(id)?;
        Some(HqCopy {
            pushed_at: rec.pushed_at.clone(),
            count: rec.rows.len(),
            last_seq: rec.rows.iter().map(|r| r.batch_seq).max().unwrap_or(0),
        })
    }

    pub fn is_auto(&self) -> bool {
        self.auto_task.is_some()
    }

    pub fn state(&self) -> StateView {
        StateView {
            version: self.version,
            auto: self.is_auto(),
            auditor: AuditorView {
                id: AUDITOR.id.into(),
                name: AUDITOR.name.into(),
                region: AUDITOR.region.into(),
                enabled: self.auditor_enabled,
            },
            hq: PartyView { id: HQ.id.into(), name: HQ.name.into(), region: HQ.region.into() },
            subs: self
                .subs
                .iter()
                .map(|s| SubView {
                    id: s.node.id.clone(),
                    name: s.cfg.name.into(),
                    region: s.cfg.region.into(),
                    db: s.cfg.db.into(),
                    currency: s.cfg.currency.into(),
                    pending: s.node.pending.len(),
                    last_seq: s.node.last_seq(),
                    last_head: s.node.last_head().to_string(),
                    store_count: s.node.store.len(),
                    members: self
                        .ledger
                        .copy(&s.node.id, &s.node.chain_id)
                        .map(|c| c.members.clone())
                        .unwrap_or_default(),
                    hq_copy: self.hq_copy(&s.node.id),
                })
                .collect(),
            last_verify: self.last_verify.clone(),
            activity: self.activity.iter().take(ACTIVITY_SHOWN).cloned().collect(),
            envelopes: self.ledger.envelopes().len(),
        }
    }

    pub fn pending(&self, id: &str) -> Result<PendingView> {
        let node = &self.sub(id)?.node;
        Ok(PendingView {
            pending: node
                .pending
                .iter()
                .map(|r| PendingRow {
                    id: r.id.clone(),
                    op: r.event.op,
                    table: r.event.source.table.clone(),
                    key: r.event.key.id.clone(),
                    committed_at: r.event.committed_at.clone(),
                    description: describe(&r.event),
                    raw: r.raw.clone(),
                    event: r.event.clone(),
                })
                .collect(),
        })
    }

    pub fn capture(&mut self, id: &str, count: Option<i64>) -> Result<PendingView> {
        let n = count.filter(|c| *c != 0).unwrap_or(5).clamp(1, 20) as usize;
        let s = self.sub_mut(id)?;
        s.node.capture(n, now_ms());
        let db = s.cfg.db;
        self.log(Level::Info, id, format!("Debezium captured {} from {db}", plural(n, "change")));
        self.pending(id)
    }

    pub fn seal(&mut self, id: &str) -> Result<BatchDetail> {
        self.seal_inner(id, false)
    }

    fn seal_inner(&mut self, id: &str, quiet: bool) -> Result<BatchDetail> {
        let idx = self
            .subs
            .iter()
            .position(|s| s.node.id == id)
            .ok_or_else(|| DemoError::not_found(format!("Unknown subsidiary {id}")))?;
        let (seq, count, root, signatories) = {
            let (batch, anchor) =
                self.subs[idx].node.seal(self.ledger.as_mut(), now_ms()).map_err(|e| DemoError::conflict(e.0))?;
            (batch.seq, batch.event_count as usize, batch.merkle_root.clone(), anchor.signatories)
        };
        if !quiet {
            self.log(
                Level::Ok,
                id,
                format!(
                    "Sealed batch #{seq}: {} → root {}. Anchored on the ledger, co-signed by {}",
                    plural(count, "event"),
                    short(&root),
                    signatories.join(" + ")
                ),
            );
        }
        self.batch_detail(id, seq)
    }

    pub fn batch_detail(&self, id: &str, seq: u64) -> Result<BatchDetail> {
        let node = &self.sub(id)?.node;
        let batch = node.batch(seq).ok_or_else(|| DemoError::not_found(format!("{id} has no batch #{seq}")))?;
        let anchor = self
            .ledger
            .copy(id, &node.chain_id)
            .and_then(|c| c.anchors.iter().find(|a| a.seq == seq))
            .ok_or_else(|| DemoError::not_found(format!("{id}'s ledger copy has no anchor #{seq}")))?;
        Ok(BatchDetail {
            chain: id.into(),
            seq,
            total_batches: node.batches.len(),
            batch: batch.clone(),
            anchor: anchor.clone(),
        })
    }

    pub fn ledger_view(&self, party: &str) -> Result<LedgerView> {
        if !self.is_party(party) {
            return Err(DemoError::not_found(format!("Unknown party {party}")));
        }
        let env = self.ledger.envelopes();
        Ok(LedgerView {
            party: party.into(),
            chains: self.ledger.view(party),
            synchronizer: env.iter().rev().take(SYNC_SHOWN).cloned().collect(),
            total_envelopes: env.len(),
        })
    }

    pub fn rewrite(&mut self, actor: &str, chain: &str, seq: i64) -> Result<ArchiveAttempt> {
        if !self.is_party(actor) {
            return Err(DemoError::bad(format!("Unknown party {actor}")));
        }
        self.sub(chain)?;
        let seq = seq.max(0) as u64;
        let res = self.ledger.attempt_archive(chain, actor, seq).map_err(|e| DemoError::bad(e.0))?;
        let text = if res.required.is_empty() {
            format!("Tried to archive an anchor on chain {chain}. Rejected: {actor} is not a stakeholder of that chain")
        } else {
            format!(
                "Tried to archive AuditAnchor #{seq} on chain {chain}. Rejected: missing signature{} from {}",
                if res.missing.len() > 1 { "s" } else { "" },
                res.missing.join(" and ")
            )
        };
        self.log(Level::Warn, actor, text);
        Ok(res)
    }

    pub fn trail(&self, held_in: &str, chain: &str) -> Result<TrailView> {
        let s = self.sub(chain)?;
        let holder = TrailHolder::parse(held_in).ok_or_else(|| DemoError::bad(r#"where must be "sub" or "hq""#))?;
        let rows = |rows: &[StoreRow]| -> Vec<TrailRowView> {
            rows.iter()
                .map(|r| TrailRowView {
                    id: r.id.clone(),
                    batch_seq: r.batch_seq,
                    index: r.index,
                    op: r.event.op,
                    table: r.event.source.table.clone(),
                    key: r.event.key.id.clone(),
                    description: describe(&r.event),
                    salt: r.salt.clone(),
                    leaf_hash: r.leaf_hash.clone(),
                    event: r.event.clone(),
                })
                .collect()
        };
        Ok(match holder {
            TrailHolder::Sub => TrailView {
                held_in: holder,
                chain: chain.into(),
                holder: chain.into(),
                location: s.cfg.region.into(),
                pushed_at: None,
                rows: rows(&s.node.store),
            },
            TrailHolder::Hq => {
                let rec = self.hq_received.get(chain);
                TrailView {
                    held_in: holder,
                    chain: chain.into(),
                    holder: HQ.id.into(),
                    location: HQ.region.into(),
                    pushed_at: rec.map(|r| r.pushed_at.clone()),
                    rows: rec.map(|r| rows(&r.rows)).unwrap_or_default(),
                }
            }
        })
    }

    pub fn push(&mut self, chain: &str) -> Result<PushResult> {
        self.push_trail(chain, false)
    }

    fn push_trail(&mut self, chain: &str, quiet: bool) -> Result<PushResult> {
        let store = self.sub(chain)?.node.store.clone();
        let batches = store.iter().map(|r| r.batch_seq).collect::<BTreeSet<_>>().len();
        let count = store.len();
        self.hq_received.insert(chain.into(), Received { pushed_at: now_iso(), rows: store });
        if !quiet {
            self.log(
                Level::Info,
                chain,
                format!(
                    "Pushed its audit trail upstream to HQ: {count} events across {batches} batch{}",
                    if batches == 1 { "" } else { "es" }
                ),
            );
        }
        let c = self.hq_copy(chain).expect("just inserted");
        Ok(PushResult { ok: true, pushed_at: c.pushed_at, count: c.count, last_seq: c.last_seq })
    }

    pub fn tamper(&mut self, req: &TamperRequest) -> Result<TamperResult> {
        let chain = req.chain.as_str();
        self.sub(chain)?;
        let holder =
            TrailHolder::parse(&req.held_in).ok_or_else(|| DemoError::bad(r#"where must be "sub" or "hq""#))?;
        let rows = match holder {
            TrailHolder::Sub => &mut self.sub_mut(chain)?.node.store,
            TrailHolder::Hq => {
                &mut self
                    .hq_received
                    .get_mut(chain)
                    .ok_or_else(|| DemoError::bad(format!("HQ holds no trail from {chain} yet")))?
                    .rows
            }
        };
        let idx = rows
            .iter()
            .position(|r| r.id == req.event_id)
            .ok_or_else(|| DemoError::not_found(format!("No event {} in that trail", req.event_id)))?;
        let description = match req.mode {
            TamperMode::Delete => {
                let row = rows.remove(idx);
                format!("deleted {} ({})", row.id, describe(&row.event).text)
            }
            TamperMode::Edit => {
                let row = &mut rows[idx];
                let d = sthira_profiles::tamper(&mut row.event);
                if req.cover {
                    row.leaf_hash = leaf_hash(&row.salt, &row.event);
                }
                d
            }
        };
        let (who, place) = match holder {
            TrailHolder::Hq => (HQ.id.to_string(), format!("HQ's copy of {chain}'s trail")),
            TrailHolder::Sub => (chain.to_string(), format!("{chain}'s audit store")),
        };
        let cover = if req.cover && req.mode == TamperMode::Edit {
            ". The stored leaf hash was recomputed to cover the tracks."
        } else {
            ""
        };
        self.log(Level::Danger, &who, format!("Someone altered {place} after it was anchored: {description}{cover}"));
        Ok(TamperResult { ok: true, description })
    }

    pub fn verify(&mut self, verifier: &str, chain: &str) -> Result<VerifyResponse> {
        if verifier != HQ.id && verifier != AUDITOR.id {
            return Err(DemoError::bad("Verifier must be HQ or AUDITOR"));
        }
        if verifier == AUDITOR.id && !self.auditor_enabled {
            return Err(DemoError::bad("Add the auditor to the network first"));
        }
        self.sub(chain)?;
        let rec = self
            .hq_received
            .get(chain)
            .ok_or_else(|| DemoError::bad(format!("HQ holds no trail from {chain}. Push it first.")))?;
        // The verifier reads anchors from ITS OWN ledger copy.
        let copy = self
            .ledger
            .copy(verifier, chain)
            .ok_or_else(|| DemoError::bad(format!("{verifier}'s node holds no copy of chain {chain}")))?;
        let report = verify_trail(chain, &copy.genesis_head, &copy.anchors, &rec.rows);
        let resp = VerifyResponse {
            verifier: verifier.into(),
            chain: chain.into(),
            trail_pushed_at: rec.pushed_at.clone(),
            anchors_count: copy.anchors.len(),
            members: copy.members.clone(),
            report,
        };
        let r = &resp.report;
        self.last_verify.insert(
            chain.into(),
            LastVerify {
                verifier: verifier.into(),
                ok: r.ok,
                at: now_iso(),
                failed_seqs: r.failed_seqs.clone(),
                first_bad_seq: r.first_bad_seq,
            },
        );
        let who = party_label(verifier);
        let text = if r.ok {
            format!(
                "{who} verified {chain}'s trail: all {} batches match the anchors on its own ledger copy",
                r.batches.len()
            )
        } else {
            let first =
                r.first_bad_seq.or_else(|| r.failed_seqs.first().copied()).map_or("?".into(), |s| s.to_string());
            let n = r.failed_seqs.len();
            format!(
                "{who} verified {chain}'s trail: batch #{first} does not match its anchor. {n} batch{} fail. The trail was altered after capture.",
                if n == 1 { "" } else { "es" }
            )
        };
        self.log(if r.ok { Level::Ok } else { Level::Danger }, verifier, text);
        Ok(resp)
    }

    pub fn add_auditor(&mut self) -> Result<StateView> {
        if self.auditor_enabled {
            return Ok(self.state());
        }
        let ids: Vec<String> = self.subs.iter().map(|s| s.node.id.clone()).collect();
        for id in &ids {
            self.ledger.add_member(id, AUDITOR.id, id).map_err(|e| DemoError::bad(e.0))?;
        }
        self.auditor_enabled = true;
        self.log(
            Level::Ok,
            AUDITOR.id,
            "Joined the network. Every member signed its admission. Its node now holds a copy of every chain, \
             and every new anchor is co-signed by the subsidiary, HQ and the auditor",
        );
        Ok(self.state())
    }

    /// One auto-anchor round: each subsidiary captures a few changes and seals a batch.
    pub fn auto_tick(&mut self) {
        let mut rng = rand::rng();
        let ids: Vec<String> = self.subs.iter().map(|s| s.node.id.clone()).collect();
        let mut done = Vec::new();
        for id in &ids {
            let n = rng.random_range(1..=4);
            if let Ok(s) = self.sub_mut(id) {
                s.node.capture(n, now_ms());
            }
            match self.seal_inner(id, true) {
                Ok(d) => done.push(format!("{id} #{}", d.seq)),
                Err(e) => self.log(Level::Warn, "Network", e.message),
            }
        }
        self.log(Level::Ok, "Network", format!("Auto-anchor: {}", done.join(", ")));
    }
}

/// Turns auto-anchoring on or off. The background task holds only a weak reference to the world.
pub fn set_auto(shared: &Shared, on: bool) -> StateView {
    let mut w = shared.lock().expect("world lock");
    if on && !w.is_auto() {
        let weak: Weak<Mutex<World>> = Arc::downgrade(shared);
        w.auto_task = Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + AUTO_INTERVAL, AUTO_INTERVAL);
            loop {
                tick.tick().await;
                let Some(world) = weak.upgrade() else { break };
                world.lock().expect("world lock").auto_tick();
            }
        }));
        w.log(
            Level::Info,
            "Network",
            "Auto-anchor on: each subsidiary captures changes and seals a batch every 10 seconds",
        );
    } else if !on && w.is_auto() {
        if let Some(t) = w.auto_task.take() {
            t.abort();
        }
        w.log(Level::Info, "Network", "Auto-anchor off");
    }
    w.state()
}
