//! A simulated ERP database plus its Debezium connector.

use rand::rngs::StdRng;
use rand::seq::IndexedRandom;
use rand::{Rng, SeedableRng};
use serde::Serialize;
use serde_json::Value;

use crate::debezium::{DebeziumEvent, DebeziumSource};
use crate::money;

const VENDOR_NAMES: [&str; 16] = [
    "Northwind Supplies",
    "Kestrel Logistics",
    "Bluegate Components",
    "Orchid Packaging",
    "Meridian Freight",
    "Saltmarsh Chemicals",
    "Ironleaf Tooling",
    "Copperline Electricals",
    "Harbourview Services",
    "Granite Ridge Metals",
    "Silverfern Textiles",
    "Lumen Office Systems",
    "Redcliff Engineering",
    "Tidewater Imports",
    "Brightpath Consulting",
    "Cobalt Warehousing",
];
const ACCOUNTS: [(&str, &str); 8] = [
    ("4000", "Revenue · product sales"),
    ("4100", "Revenue · services"),
    ("5000", "Cost of goods sold"),
    ("6100", "Salaries and wages"),
    ("6200", "Rent and facilities"),
    ("6400", "Freight and logistics"),
    ("1500", "Capital expenditure"),
    ("2100", "Intercompany payable · HQ"),
];

/// What the source needs to know about the subsidiary it simulates.
#[derive(Debug, Clone)]
pub struct SourceConfig {
    pub id: String,
    /// Debezium connector: `postgresql` or `oracle`.
    pub connector: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize)]
struct JournalEntry {
    id: String,
    entry_date: String,
    account: String,
    description: String,
    amount: String,
    currency: String,
    status: String,
    modified_by: String,
}

#[derive(Debug, Clone, Serialize)]
struct Vendor {
    id: String,
    name: String,
    bank_account: String,
    tax_id: String,
    status: String,
    modified_by: String,
}

#[derive(Clone, Copy)]
enum Kind {
    JePosted,
    JeAmended,
    VendorCreated,
    VendorBankChange,
    VendorStatusChange,
}

/// Stands in for one subsidiary's ERP database and its Debezium connector.
pub struct FinanceSource {
    cfg: SourceConfig,
    rng: StdRng,
    jes: Vec<JournalEntry>,
    vendors: Vec<Vendor>,
    next_je: u32,
    next_vendor: u32,
    pos: u64,
    tx: u64,
    service: String,
}

fn row<T: Serialize>(r: &T) -> Value {
    serde_json::to_value(r).expect("plain struct serialises")
}

impl FinanceSource {
    pub fn new(cfg: SourceConfig) -> Self {
        Self::from_rng(cfg, StdRng::from_os_rng())
    }

    /// Deterministic source, for tests.
    pub fn with_seed(cfg: SourceConfig, seed: u64) -> Self {
        Self::from_rng(cfg, StdRng::seed_from_u64(seed))
    }

    fn from_rng(cfg: SourceConfig, mut rng: StdRng) -> Self {
        let oracle = cfg.connector == "oracle";
        let tx = rng.random_range(5000..=9000);
        let service = format!("erp_svc_{}", cfg.id.to_lowercase());
        let mut s = Self {
            cfg,
            rng,
            jes: Vec::new(),
            vendors: Vec::new(),
            next_je: 1001,
            next_vendor: 201,
            pos: if oracle { 48_210_000 } else { 0x1a3_f000 },
            tx,
            service,
        };
        for _ in 0..4 {
            s.new_vendor(); // master data that existed before capture started
        }
        s
    }

    fn oracle(&self) -> bool {
        self.cfg.connector == "oracle"
    }

    fn bank_account(&mut self) -> String {
        let r = &mut self.rng;
        format!("ACCT {}-{}-{}", r.random_range(1000..=9999), r.random_range(1000..=9999), r.random_range(1000..=9999))
    }

    fn new_vendor(&mut self) -> usize {
        let free: Vec<&str> =
            VENDOR_NAMES.iter().copied().filter(|n| !self.vendors.iter().any(|v| v.name == *n)).collect();
        let id = format!("V-{}", self.next_vendor);
        self.next_vendor += 1;
        let name = free.choose(&mut self.rng).map(|s| s.to_string()).unwrap_or_else(|| format!("Vendor {id}"));
        let bank_account = self.bank_account();
        let tax_id = format!("TX-{}", self.rng.random_range(100_000..=999_999));
        self.vendors.push(Vendor {
            id,
            name,
            bank_account,
            tax_id,
            status: "active".into(),
            modified_by: self.service.clone(),
        });
        self.vendors.len() - 1
    }

    fn position(&mut self) -> (Option<String>, Option<String>) {
        self.pos += self.rng.random_range(40..=400);
        if self.oracle() { (None, Some(self.pos.to_string())) } else { (Some(format!("0/{:X}", self.pos)), None) }
    }

    fn kind(&mut self) -> Kind {
        let r: f64 = self.rng.random();
        match r {
            _ if r < 0.42 || self.jes.is_empty() => Kind::JePosted,
            _ if r < 0.58 => Kind::JeAmended,
            _ if r < 0.70 => Kind::VendorCreated,
            _ if r < 0.88 => Kind::VendorBankChange,
            _ => Kind::VendorStatusChange,
        }
    }

    /// Applies one business change at `ts` (Unix ms) and returns the Debezium change event for it.
    pub fn next(&mut self, ts: i64) -> DebeziumEvent {
        let (table, op, before, after) = match self.kind() {
            Kind::JePosted => {
                let (account, description) = *ACCOUNTS.choose(&mut self.rng).expect("non-empty");
                let amount = self.rng.random_range(1200..=95_000) as f64 + self.rng.random_range(0..=99) as f64 / 100.0;
                let je = JournalEntry {
                    id: format!("JE-{}", self.next_je),
                    entry_date: crate::iso_micros(ts)[..10].to_string(),
                    account: account.into(),
                    description: description.into(),
                    amount: money(amount),
                    currency: self.cfg.currency.clone(),
                    status: "posted".into(),
                    modified_by: self.service.clone(),
                };
                self.next_je += 1;
                let after = row(&je);
                self.jes.push(je);
                ("journal_entries", "c", None, after)
            }
            Kind::JeAmended => {
                let i = self.rng.random_range(0..self.jes.len());
                let sign = if self.rng.random_bool(0.5) { -1.0 } else { 1.0 };
                let factor = 1.0 + sign * self.rng.random_range(1..=8) as f64 / 100.0;
                let before = row(&self.jes[i]);
                let je = &mut self.jes[i];
                je.amount = money(je.amount.parse::<f64>().unwrap_or(0.0) * factor);
                ("journal_entries", "u", Some(before), row(je))
            }
            Kind::VendorCreated => {
                let i = self.new_vendor();
                ("vendors", "c", None, row(&self.vendors[i]))
            }
            Kind::VendorBankChange => {
                let i = self.rng.random_range(0..self.vendors.len());
                let before = row(&self.vendors[i]);
                self.vendors[i].bank_account = self.bank_account();
                ("vendors", "u", Some(before), row(&self.vendors[i]))
            }
            Kind::VendorStatusChange => {
                let i = self.rng.random_range(0..self.vendors.len());
                let before = row(&self.vendors[i]);
                let v = &mut self.vendors[i];
                v.status = if v.status == "active" { "blocked" } else { "active" }.into();
                ("vendors", "u", Some(before), row(v))
            }
        };
        let oracle = self.oracle();
        let lower = self.cfg.id.to_lowercase();
        let (lsn, scn) = self.position();
        let tx_id = self.tx.to_string();
        self.tx += 1;
        let lag = self.rng.random_range(40..=900);
        DebeziumEvent {
            before,
            after: Some(after),
            source: DebeziumSource {
                version: "3.7.0.Final".into(),
                connector: self.cfg.connector.clone(),
                name: format!("erp_{lower}"),
                ts_ms: ts,
                db: if oracle { "ERPPDB".into() } else { format!("erp_{lower}") },
                schema: if oracle { "ERP" } else { "public" }.into(),
                table: table.into(),
                tx_id,
                lsn,
                scn,
            },
            op: op.into(),
            ts_ms: ts + lag,
            transaction: None,
        }
    }
}
