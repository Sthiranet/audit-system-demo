//! Runs the narrated story against the backend and checks each claim (port of the old `test/scenario.js`).

use demo_director::views::{TamperMode, TamperRequest};
use demo_director::{World, set_auto};

fn tamper(w: &mut World, held_in: &str, chain: &str, event_id: &str, mode: TamperMode, cover: bool) {
    w.tamper(&TamperRequest { held_in: held_in.into(), chain: chain.into(), event_id: event_id.into(), mode, cover })
        .expect("tamper");
}

#[tokio::test]
async fn the_story() {
    let mut w = World::new();

    // 1. Normal operation: capture, seal, anchor co-signed by S1 + HQ, chained to #3.
    w.capture("S1", Some(10)).unwrap();
    let b = w.seal("S1").unwrap();
    assert_eq!(b.seq, 4);
    assert_eq!(b.batch.event_count, 10);
    assert_eq!(b.anchor.signatories, ["S1", "HQ"]);
    assert_eq!(b.anchor.merkle_root, b.batch.merkle_root);
    assert_eq!(b.anchor.prev_head, w.batch_detail("S1", 3).unwrap().batch.head);
    // Spec v1: the anchor carries source log positions, and they match the batch.
    assert_eq!((&b.anchor.from_pos, &b.anchor.to_pos), (&b.batch.from_pos, &b.batch.to_pos));
    assert_eq!(b.batch.items[0].salt.len(), 64, "32-byte salts");

    // 2. HQ holds copies of all three chains; S1 sees only its own; S2 cannot see S1.
    let hq = w.ledger_view("HQ").unwrap();
    assert_eq!(hq.chains.len(), 3);
    assert_eq!(hq.chains.iter().find(|c| c.chain_id == "S1").unwrap().last_seq, 4);
    assert_eq!(w.ledger_view("S1").unwrap().chains.len(), 1);
    assert!(w.ledger_view("S2").unwrap().chains.iter().all(|c| c.chain_id != "S1"));

    // 3. An empty batch is still anchored (silence is visible).
    let empty = w.seal("S2").unwrap();
    assert_eq!(empty.batch.event_count, 0);

    // 4. HQ verifies S1's pushed trail: all 4 batches match.
    w.push("S1").unwrap();
    let v = w.verify("HQ", "S1").unwrap();
    assert!(v.report.ok, "clean trail should verify");
    assert_eq!(v.report.batches.len(), 4);

    // 5. Edit batch #2 at S1, push to HQ: root #2 mismatches, the leaf is pinpointed, heads #3+ cascade.
    let target = w.trail("sub", "S1").unwrap().rows.into_iter().find(|r| r.batch_seq == 2).unwrap();
    tamper(&mut w, "sub", "S1", &target.id, TamperMode::Edit, false);
    w.push("S1").unwrap();
    let v = w.verify("HQ", "S1").unwrap().report;
    assert!(!v.ok);
    assert_eq!(v.first_bad_seq, Some(2));
    let b2 = v.batches.iter().find(|x| x.seq == 2).unwrap();
    assert!(!b2.root_match && !b2.head_match);
    assert_eq!(b2.leaf_issues[0].event_id, target.id);
    assert!(v.batches.iter().find(|x| x.seq == 1).unwrap().ok);
    let b3 = v.batches.iter().find(|x| x.seq == 3).unwrap();
    assert!(b3.root_match && !b3.head_match, "later heads cascade");
    assert!(!w.state().last_verify["S1"].ok);

    // 6. Tamper with the leaf hash recomputed: no leaf flag, but the root still mismatches.
    w.reset();
    let t2 = w.trail("sub", "S1").unwrap().rows.into_iter().find(|r| r.batch_seq == 3).unwrap();
    tamper(&mut w, "sub", "S1", &t2.id, TamperMode::Edit, true);
    w.push("S1").unwrap();
    let v = w.verify("HQ", "S1").unwrap().report;
    assert_eq!(v.first_bad_seq, Some(3));
    assert!(v.batches.iter().find(|x| x.seq == 3).unwrap().leaf_issues.is_empty());

    // 7. Deleted record: event count and root mismatch, missing position reported.
    w.reset();
    let t3 = w.trail("sub", "S2").unwrap().rows.into_iter().find(|r| r.batch_seq == 1).unwrap();
    tamper(&mut w, "sub", "S2", &t3.id, TamperMode::Delete, false);
    w.push("S2").unwrap();
    let v = w.verify("HQ", "S2").unwrap().report;
    let d1 = v.batches.iter().find(|x| x.seq == 1).unwrap();
    assert!(!d1.count_match && !d1.root_match);
    assert_eq!(d1.missing_indexes, [t3.index]);

    // 8. Nobody can rewrite the ledger alone; S2 cannot even see S1's anchors.
    let r = w.rewrite("S1", "S1", 2).unwrap();
    assert!(!r.ok);
    assert_eq!(r.missing, ["HQ"]);
    assert_eq!(w.rewrite("HQ", "S1", 2).unwrap().missing, ["S1"]);
    assert!(w.rewrite("S2", "S1", 2).unwrap().required.is_empty());

    // 9. Auditor joins: new anchors carry 3 signatures; the auditor catches an edit made to HQ's copy.
    assert!(w.verify("AUDITOR", "S1").is_err());
    w.add_auditor().unwrap();
    w.capture("S1", Some(3)).unwrap();
    let b5 = w.seal("S1").unwrap();
    assert_eq!(b5.anchor.signatories, ["S1", "HQ", "AUDITOR"]);
    assert_eq!(w.ledger_view("AUDITOR").unwrap().chains.len(), 3);
    w.push("S1").unwrap();
    assert!(w.verify("AUDITOR", "S1").unwrap().report.ok);
    let hq_row = w.trail("hq", "S1").unwrap().rows.remove(0);
    tamper(&mut w, "hq", "S1", &hq_row.id, TamperMode::Edit, false);
    assert!(!w.verify("AUDITOR", "S1").unwrap().report.ok);
    assert_eq!(w.rewrite("HQ", "S1", b5.seq as i64).unwrap().missing, ["S1", "AUDITOR"]);

    // 10. Auto-anchor toggles on and off.
    let shared = World::shared();
    assert!(set_auto(&shared, true).auto);
    assert!(!set_auto(&shared, false).auto);
}

#[test]
fn errors_are_reported_with_status() {
    let mut w = World::new();
    assert_eq!(w.seal("S9").unwrap_err().status, 404);
    assert_eq!(w.trail("elsewhere", "S1").unwrap_err().status, 400);
    assert_eq!(w.verify("S1", "S1").unwrap_err().status, 400);
    assert_eq!(w.batch_detail("S1", 99).unwrap_err().status, 404);
    assert_eq!(w.rewrite("S1", "S1", 99).unwrap_err().status, 400);
}

#[test]
fn auto_tick_anchors_every_chain() {
    let mut w = World::new();
    w.auto_tick();
    assert!(w.state().subs.iter().all(|s| s.last_seq == 4 && s.pending == 0));
}
