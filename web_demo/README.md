# Sthiranet · Group Audit Trail Demo

A small web app for live presentations. It shows how a group's audit trail is batched, hashed into
Merkle roots, co-signed on a ledger, and how recomputing the hashes catches a trail that was altered
after the fact. You do the narration; the app gives you the visuals.

The cast follows the story: **HQ** in Region R, subsidiaries **S1, S2, S3** in Regions R1–R3, and an
optional **external auditor**.

## Run it

Requires Node.js 18 or newer. No `npm install` needed: there are no dependencies.

```
cd sthiranet-demo-app
npm start            # or: node server.js
```

Open http://localhost:3000. Use a different port with `PORT=4000 npm start`.

`npm test` runs the whole story against the backend and checks each claim (10 checks).

The demo opens on a live network: each subsidiary already has 3 anchored batches, and HQ already
holds a copy of each trail. **Reset demo** (click twice) restores that starting point at any time.

## Screen layout

- **Network strip** (top): HQ, S1–S3 and the auditor. Click a subsidiary to select it. The dot on each
  subsidiary is its last verification result (green: match, red: tamper found).
- **Activity** (right): everything that happened, in order. **Hide activity** gives the diagrams more
  room on a projector.
- **Auto-anchor every 10 s** (top right): each subsidiary captures a few changes and seals a batch every
  10 seconds, so the network looks alive while you talk. Turn it off before a scripted sequence.

Four tabs, in story order:

| Tab | What it shows |
| --- | --- |
| 1 · Capture & batch | Changes captured by Debezium (click a row for the raw event). **Seal batch** hashes each change into a salted leaf, builds the Merkle tree (animated) and shows the AuditAnchor stored on the ledger: `seq`, `merkle_root`, `prev_head`, `head`, signatories. Browse older batches with prev/next. |
| 2 · Ledger | The ledger as stored on any party's node. HQ holds all three chains; S1 holds only its own. Only fingerprints are on it. **Try to rewrite history** shows that no single party can archive an anchor. **What the synchronizer sees** shows encrypted envelopes only. |
| 3 · Off-ledger audit trail | The structured records, in the subsidiary's store or in HQ's received copy. **Alter** / **Delete** play the corrupt employee or the bug. **Push trail to HQ** sends the trail upstream. |
| 4 · Verify | HQ (or the auditor) recomputes every leaf, root and head from the trail and compares them with the anchors on **its own** ledger copy. Mismatches are shown per batch, with the recomputed tree and the altered record highlighted. |

## Click-through for the narration

**1. The setup.** Point at the network strip: HQ in R, subsidiaries in R1–R3, one private
synchronizer, only hashes cross it.

**2. How the ledger side works** (tab 1, S1 selected)
1. Click **+10**. Open one row to show a Debezium change event and the normalised event.
2. Click **Seal batch**. The tree builds from the 10 leaves up to the Merkle root.
3. Scroll to step 3: the AuditAnchor with `seq`, `merkle_root`, `prev_head` (the previous batch's head)
   and `head`, signed by S1 and HQ.
4. Tab 2: the chain of anchors, linked by heads. Switch between **HQ** and **S1** to show that HQ holds
   S1's chained hashes on its own node, and S1 cannot see S2's chain.

**3. The two benefits**
- *Immutability*: tab 2 → **Try to rewrite history** → S1, chain S1, anchor 2 → **Attempt to archive**.
  Rejected: HQ did not sign. Repeat with HQ as the actor: rejected, S1 did not sign.
- *Integrity*: the tamper story below.
- *Data residency* (if asked): tab 2's lead text and the synchronizer table. Records stay in each
  region; only roots, heads, counts and time windows are shared.

**4. The tamper story**
1. Tab 3, S1, **S1's audit store**. Click **Alter** on a journal entry in batch #2 (its amount changes
   tenfold). Optionally tick *recompute the stored leaf hash* first, to show that covering your
   tracks doesn't help.
2. Click **Push S1's trail to HQ**. The altered trail is now upstream.
3. Optional: switch to **HQ's received copy** to show that it looks perfectly normal.
4. Tab 4, verifier **HQ**, chain **S1** → **Run verification**. Batch #2's recomputed root does not
   match the root anchored on HQ's ledger copy, the altered record is highlighted in the tree, and
   every later head fails too, because each head includes the one before it. S1's dot turns red.

**5. The auditor (reserve)**
1. Click **Add auditor**. Every chain now has three members; new anchors carry three signatures
   (seal a batch in tab 1 to show it).
2. Tab 4, verifier **Auditor** → **Run verification**: the auditor checks the trail HQ holds against
   its own ledger copy.
3. To show that HQ is accountable too: tab 3 → **HQ's received copy** → **Alter** a record → tab 4,
   verifier **Auditor** → the auditor catches HQ's edit.

## How it maps to Sthiranet's architecture

The code is split along the three layers of the technical overview, so the same skeleton can grow into
the MVP or be re-skinned for another industry:

| Layer | Folder | In this demo |
| --- | --- | --- |
| Kernel | `src/kernel/` | `crypto.js`: salted leaves, RFC 6962-style Merkle tree, chained heads. `ledger.js`: a stand-in for Canton (per-party node copies, co-signed appends, archive needs every signatory, synchronizer sees only encrypted envelopes). |
| Connector | `src/connectors/` | `finance-profile.js`: simulated ERP tables and Debezium change events for journal entries and vendors, plus their business meaning. A CCTV or lending demo would swap only this file. |
| Node | `src/node/` | `subsidiary.js`: pending changes, sealing batches, the off-ledger audit store. `verifier.js`: recomputes and compares. |

`src/demo.js` wires the parties together (rename the cast at the top of that file) and `server.js`
exposes it over HTTP. The UI lives in `public/`.

### What is simplified

This is a presentation demo, not the build plan's backend. In particular:

- **No real Canton.** The ledger is an in-memory simulation that reproduces the behaviour the story
  relies on: each party keeps its own copy, every member co-signs, a fork or skipped sequence is
  refused, and archiving needs every signatory. The real system uses the Daml templates in the build plan.
- **No real Debezium or databases.** Changes are generated in memory in Debezium's event shape.
- **The hashing is real** (SHA-256, salted leaves, Merkle trees, chained heads), following the build
  plan's hashing spec in a simplified form.
- State is in memory and resets when the server restarts.
