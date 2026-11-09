//! Connector layer · finance record profile.
//!
//! 1. [`FinanceSource`] stands in for a subsidiary's ERP database plus Debezium: it changes rows in
//!    `journal_entries` and `vendors` and emits Debezium-shaped change events (schemas off).
//! 2. [`normalize`] turns a Debezium event into the [`Event`] that gets hashed.
//! 3. [`describe`] gives each change a business meaning ("posted entry amended", "vendor bank account changed").
//!
//! Another industry (lending, CCTV hashes, pharma batches) would get its own profile; the kernel and
//! node layers don't change.

mod debezium;
mod source;

pub use debezium::{DebeziumEvent, DebeziumSource};
pub use source::{FinanceSource, SourceConfig};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sthira_core::{Actor, Event, EventSource, Op, RecordKey, SPEC_VERSION};

/// RFC 3339 UTC with microseconds (spec v1) from Unix milliseconds.
pub fn iso_micros(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Micros, true)
}

/// The current time in spec v1 format.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true)
}

/// The business meaning of a change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Description {
    pub kind: String,
    pub label: String,
    pub text: String,
}

fn str_field<'a>(row: Option<&'a Value>, k: &str) -> &'a str {
    row.and_then(|r| r.get(k)).and_then(Value::as_str).unwrap_or("")
}

/// Turns a Debezium change event into the normalised event that gets hashed.
pub fn normalize(raw: &DebeziumEvent, chain_id: &str) -> Event {
    let row = raw.after.as_ref().or(raw.before.as_ref());
    let modified_by = str_field(row, "modified_by").to_string();
    let s = &raw.source;
    Event {
        v: SPEC_VERSION,
        chain: chain_id.to_string(),
        source: EventSource {
            connector: s.connector.clone(),
            db: s.db.clone(),
            schema: s.schema.clone(),
            table: s.table.clone(),
            pos: s.lsn.clone().or_else(|| s.scn.clone()).unwrap_or_default(),
            tx: s.tx_id.clone(),
        },
        key: RecordKey { id: str_field(row, "id").to_string() },
        op: Op::from_debezium(&raw.op).unwrap_or(Op::Update),
        before: raw.before.clone(),
        after: raw.after.clone(),
        actor: Actor {
            kind: if modified_by.starts_with("erp_svc") { "service" } else { "user" }.to_string(),
            name: modified_by,
        },
        committed_at: iso_micros(s.ts_ms),
        captured_at: iso_micros(raw.ts_ms),
    }
}

/// `1234.5` → `1,234.50`.
pub fn fmt_money(s: &str) -> String {
    let v: f64 = s.parse().unwrap_or(0.0);
    let fixed = format!("{:.2}", v.abs());
    let (int, frac) = fixed.split_once('.').unwrap_or((&fixed, "00"));
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("{}{grouped}.{frac}", if v < 0.0 { "-" } else { "" })
}

/// Rounds to cents and formats with two decimals: money is always a string.
pub(crate) fn money(n: f64) -> String {
    format!("{:.2}", (n * 100.0).round() / 100.0)
}

fn d(kind: &str, label: &str, text: String) -> Description {
    Description { kind: kind.into(), label: label.into(), text }
}

/// The business meaning of a change, for screens and flag rules.
pub fn describe(ev: &Event) -> Description {
    let a = ev.after.as_ref().or(ev.before.as_ref());
    let b = ev.before.as_ref();
    let f = |k| str_field(a, k);
    let bf = |k| str_field(b, k);
    if ev.source.table == "journal_entries" {
        if ev.op == Op::Insert {
            return d(
                "je-posted",
                "Journal entry posted",
                format!("{} · {} · {} {}", f("id"), f("description"), fmt_money(f("amount")), f("currency")),
            );
        }
        if ev.op == Op::Delete {
            return d(
                "je-deleted",
                "Journal entry deleted",
                format!("{} · {} {}", f("id"), fmt_money(f("amount")), f("currency")),
            );
        }
        if bf("amount") != f("amount") {
            return d(
                "je-amended",
                "Posted entry amended",
                format!("{} · {} → {} {}", f("id"), fmt_money(bf("amount")), fmt_money(f("amount")), f("currency")),
            );
        }
        return d(
            "je-updated",
            "Journal entry updated",
            format!("{} · {} {}", f("id"), fmt_money(f("amount")), f("currency")),
        );
    }
    if ev.op == Op::Insert {
        return d("vendor-created", "Vendor created", format!("{} · {} · {}", f("id"), f("name"), f("bank_account")));
    }
    if ev.op == Op::Delete {
        return d("vendor-deleted", "Vendor deleted", format!("{} · {}", f("id"), f("name")));
    }
    if bf("bank_account") != f("bank_account") {
        return d(
            "vendor-bank-change",
            "Vendor bank account changed",
            format!("{} · {} → {}", f("id"), bf("bank_account"), f("bank_account")),
        );
    }
    if bf("status") != f("status") {
        return d(
            "vendor-status-change",
            "Vendor status changed",
            format!("{} · {} → {}", f("id"), bf("status"), f("status")),
        );
    }
    d("vendor-updated", "Vendor updated", format!("{} · {}", f("id"), f("name")))
}

/// Presenter action: what a corrupt employee (or a bug) does to a stored audit record.
/// A journal entry's amount changes tenfold; a vendor's bank account is swapped.
pub fn tamper(ev: &mut Event) -> String {
    let is_je = ev.source.table == "journal_entries";
    let Some(Value::Object(a)) = ev.after.as_mut().or(ev.before.as_mut()) else {
        return "nothing to alter".to_string();
    };
    let id = a.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if is_je {
        let old = a.get("amount").and_then(Value::as_str).unwrap_or("0").to_string();
        let v: f64 = old.parse().unwrap_or(0.0);
        let new = money(if v >= 10000.0 { v / 10.0 } else { v * 10.0 });
        let cur = a.get("currency").and_then(Value::as_str).unwrap_or("").to_string();
        a.insert("amount".into(), Value::String(new.clone()));
        return format!("{id}: amount {} → {} {cur}", fmt_money(&old), fmt_money(&new));
    }
    let old = a.get("bank_account").and_then(Value::as_str).unwrap_or("").to_string();
    let new = if old == "ACCT 9999-0042-7731" { "ACCT 9999-0042-7732" } else { "ACCT 9999-0042-7731" };
    a.insert("bank_account".into(), Value::String(new.into()));
    format!("{id}: bank account {old} → {new}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(connector: &str) -> FinanceSource {
        FinanceSource::with_seed(
            SourceConfig { id: "S1".into(), connector: connector.into(), currency: "USD".into() },
            7,
        )
    }

    #[test]
    fn money_formatting() {
        assert_eq!(fmt_money("1234.5"), "1,234.50");
        assert_eq!(fmt_money("95000"), "95,000.00");
        assert_eq!(fmt_money("12"), "12.00");
        assert_eq!(money(1.005 * 1000.0), "1005.00");
    }

    #[test]
    fn normalised_events_follow_spec_v1() {
        let mut s = src("postgresql");
        for i in 0..50 {
            let raw = s.next(1_762_000_000_000 + i * 300);
            let ev = normalize(&raw, "S1");
            assert_eq!(ev.v, 1);
            assert!(ev.source.pos.starts_with("0/"));
            assert_eq!(ev.source.schema, "public");
            assert!(ev.committed_at.ends_with("000Z") && ev.committed_at.len() == 27, "{}", ev.committed_at);
            assert_eq!(ev.actor.kind, "service");
            // Money is a string, never a float.
            if let Some(amount) = ev.after.as_ref().and_then(|a| a.get("amount")) {
                assert!(amount.is_string());
            }
            assert!(!describe(&ev).label.is_empty());
        }
        let mut o = src("oracle");
        let ev = normalize(&o.next(1_762_000_000_000), "S2");
        assert!(ev.source.pos.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(ev.source.schema, "ERP");
    }

    #[test]
    fn tamper_changes_the_hashed_content() {
        let mut s = src("postgresql");
        let raw = s.next(1_762_000_000_000); // the first change is always a posted journal entry
        let mut ev = normalize(&raw, "S1");
        let salt = sthira_core::new_salt();
        let before = sthira_core::leaf_hash(&salt, &ev);
        let msg = tamper(&mut ev);
        assert!(msg.contains("amount"), "{msg}");
        assert_ne!(before, sthira_core::leaf_hash(&salt, &ev));
    }
}
