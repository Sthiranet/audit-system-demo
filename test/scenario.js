'use strict';
// Runs the narrated story against the backend and checks each claim. `npm test`
const assert = require('assert');
const demo = require('../src/demo');

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

demo.reset();

// Normal operation: capture, seal, anchor co-signed by S1 + HQ, stored on both nodes.
demo.capture('S1', 10);
const b = demo.seal('S1');
assert.strictEqual(b.seq, 4);
assert.strictEqual(b.batch.eventCount, 10);
assert.deepStrictEqual(b.anchor.signatories, ['S1', 'HQ']);
assert.strictEqual(b.anchor.merkleRoot, b.batch.merkleRoot);
assert.strictEqual(b.anchor.prevHead, demo.batchDetail('S1', 3).batch.head);
ok('S1 seals 10 changes into batch #4; the anchor is co-signed by S1 and HQ and chains to #3');

const hqLedger = demo.ledgerView('HQ');
assert.strictEqual(hqLedger.chains.length, 3);
assert.strictEqual(hqLedger.chains.find((c) => c.chainId === 'S1').lastSeq, 4);
assert.strictEqual(demo.ledgerView('S1').chains.length, 1);
assert.strictEqual(demo.ledgerView('S2').chains.find((c) => c.chainId === 'S1'), undefined);
ok('HQ holds copies of all three chains; S1 sees only its own; S2 cannot see S1');

// Empty batch is still anchored (silence is visible).
const empty = demo.seal('S2');
assert.strictEqual(empty.batch.eventCount, 0);
ok('An empty batch is still anchored');

// Clean verification.
demo.push('S1');
let v = demo.verify('HQ', 'S1');
assert.ok(v.ok, 'clean trail should verify');
assert.strictEqual(v.batches.length, 4);
ok('HQ verifies S1\'s pushed trail: all 4 batches match');

// Tamper at S1 (edit batch #2), push upstream, HQ verifies → mismatch from #2 on.
const s1 = demo.trail('sub', 'S1');
const target = s1.rows.find((r) => r.batchSeq === 2);
demo.tamper({ where: 'sub', chain: 'S1', eventId: target.id, mode: 'edit' });
demo.push('S1');
v = demo.verify('HQ', 'S1');
assert.ok(!v.ok);
assert.strictEqual(v.firstBadSeq, 2);
const b2 = v.batches.find((x) => x.seq === 2);
assert.ok(!b2.rootMatch && !b2.headMatch);
assert.strictEqual(b2.leafIssues[0].eventId, target.id);
assert.ok(v.batches.find((x) => x.seq === 1).ok);
const b3 = v.batches.find((x) => x.seq === 3);
assert.ok(b3.rootMatch && !b3.headMatch, 'later heads cascade');
ok(`Edited ${target.id} in batch #2, pushed to HQ: root #2 mismatches, the leaf is pinpointed, heads #3+ cascade`);

// Covering tracks (recomputing the leaf hash) still fails at the root.
demo.reset();
const t2 = demo.trail('sub', 'S1').rows.find((r) => r.batchSeq === 3);
demo.tamper({ where: 'sub', chain: 'S1', eventId: t2.id, mode: 'edit', cover: true });
demo.push('S1');
v = demo.verify('HQ', 'S1');
assert.strictEqual(v.firstBadSeq, 3);
assert.strictEqual(v.batches.find((x) => x.seq === 3).leafIssues.length, 0);
ok('Tamper with the leaf hash recomputed: no leaf flag, but the root still mismatches');

// Deleting a record: count and root mismatch.
demo.reset();
const t3 = demo.trail('sub', 'S2').rows.find((r) => r.batchSeq === 1);
demo.tamper({ where: 'sub', chain: 'S2', eventId: t3.id, mode: 'delete' });
demo.push('S2');
v = demo.verify('HQ', 'S2');
const d1 = v.batches.find((x) => x.seq === 1);
assert.ok(!d1.countMatch && !d1.rootMatch);
assert.deepStrictEqual(d1.missingIndexes, [t3.index]);
ok('Deleted record: event count and root mismatch, missing position reported');

// Nobody can rewrite the ledger alone.
let r = demo.rewrite('S1', 'S1', 2);
assert.ok(!r.ok);
assert.deepStrictEqual(r.missing, ['HQ']);
r = demo.rewrite('HQ', 'S1', 2);
assert.deepStrictEqual(r.missing, ['S1']);
r = demo.rewrite('S2', 'S1', 2);
assert.strictEqual(r.required.length, 0);
ok('S1 alone and HQ alone are both refused when archiving an anchor; S2 cannot even see it');

// Auditor joins, gets copies, co-signs new anchors, verifies HQ's copy.
assert.throws(() => demo.verify('AUDITOR', 'S1'));
demo.addAuditor();
demo.capture('S1', 3);
const b5 = demo.seal('S1');
assert.deepStrictEqual(b5.anchor.signatories, ['S1', 'HQ', 'AUDITOR']);
assert.strictEqual(demo.ledgerView('AUDITOR').chains.length, 3);
demo.push('S1');
assert.ok(demo.verify('AUDITOR', 'S1').ok);
const hqRow = demo.trail('hq', 'S1').rows[0];
demo.tamper({ where: 'hq', chain: 'S1', eventId: hqRow.id, mode: 'edit' });
v = demo.verify('AUDITOR', 'S1');
assert.ok(!v.ok);
r = demo.rewrite('HQ', 'S1', b5.seq);
assert.deepStrictEqual(r.missing, ['S1', 'AUDITOR']);
ok('Auditor joins: new anchors carry 3 signatures; auditor catches an edit made to HQ\'s copy');

// Auto mode ticks.
demo.setAuto(true);
assert.ok(demo.state().auto);
demo.setAuto(false);
ok('Auto-anchor toggles on and off');

console.log(`\nAll ${step} checks passed.`);
