# Sthiranet · Group Audit Trail Demo

A small web app for live presentations. It shows how a group's audit trail is batched, hashed into
Merkle roots, co-signed on a ledger, and how recomputing the hashes catches a trail that was altered
after the fact. You do the narration; the app gives you the visuals.

The cast follows the story: **HQ** in Region R, subsidiaries **S1, S2, S3** in Regions R1–R3, and an
optional **external auditor**.

## Run it

Requires Rust (stable, 1.94 or newer) and Node.js 22.12 or newer (only to build the UI).

```
make install         # once: UI dependencies
make start           # builds the UI and the server, serves http://localhost:3000
```

Use a different port with `PORT=4000 make start`. For UI work, `make dev` runs the API on :3000 and Vite
with hot reload on http://localhost:5173.

`make test` runs the Rust tests: the whole story against the backend (the same 10 checks as before), HTTP
smoke tests, the RFC 6962 and RFC 8785 reference vectors, the spec v1 test vectors, and property tests for
Merkle proofs. It also type-checks the UI. `make check` adds formatting and clippy.

### Cleaning up

| Command | What it removes |
| --- | --- |
| `make stop` | Stops a running demo server. All demo state (batches, ledger copies, trails, activity) lives only in that process's memory, so stopping it clears it. Nothing is written to disk. |
| `make clean` | `make stop`, then every build output: the Rust `target/` folder (compiled binaries, test builds, incremental caches), the built UI (`demo/ui/dist`), Vite's cache and the generated `openapi.json`. |
| `make distclean` | `make clean`, plus the installed UI dependencies (`demo/ui/node_modules`). Run `make install` before the next build. |

The generated TypeScript API types (`demo/ui/src/api/schema.d.ts`) are kept, since they are source the UI is built
from; `make build` regenerates them anyway.

The demo opens on a live network: each subsidiary already has 3 anchored batches, and HQ already
holds a copy of each trail. **Reset demo** (click twice) restores that starting point at any time.

## Share it (free hosting on Render)

The repo carries a `Dockerfile` (UI + server in one ~120 MB image) and a `render.yaml` Blueprint for a free
Render web service.

1. Push this branch to GitHub.
2. In Render: **New → Blueprint**, pick the repository. Render reads `render.yaml` and creates the
   `sthiranet-demo` service on the free plan.
3. Share the `https://sthiranet-demo-….onrender.com` link once the first deploy finishes.

Things to know about the free plan: the service sleeps after about 15 minutes without visitors, and the first
visit after that takes 30–60 seconds while it wakes. Every wake-up starts from a freshly seeded demo. All
viewers share one demo (one person's **Reset** or tampering is everyone's), and there is no sign-in, so share
the link only with the people you mean to. Suspend the service in Render when you're done.

To try the image locally: `docker build -t sthiranet-demo . && docker run --rm -p 3000:3000 sthiranet-demo`.

For a live session from your own laptop instead, `cloudflared tunnel --url http://localhost:3000` gives a
temporary public link with no account.

The UI works on phones: below 760 px wide the page scrolls as one document, tabs stay pinned at the top, and
wide tables and Merkle trees scroll sideways inside their own boxes.

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

The code follows the build plan's layers and crate names, so the foundation can grow into the MVP and
everything demo-only can be deleted cleanly. Nothing in `crates/` depends on `demo/`.

| Layer | Folder | In this demo |
| --- | --- | --- |
| Kernel | `crates/sthira-core` | Hashing spec v1: RFC 8785 canonical JSON, 32-byte salted leaves, RFC 6962 Merkle tree and inclusion proofs, chained heads, genesis. Pure Rust, no I/O. |
| Kernel | `crates/sthira-ledger` | The `AuditLedger` trait and `SimLedger`, a stand-in for Canton (per-party node copies, co-signed appends, archive needs every signatory, synchronizer sees only encrypted envelopes). A Canton client will implement the same trait. |
| Connector | `crates/sthira-profiles` | The finance profile: simulated ERP tables and Debezium change events for journal entries and vendors, normalisation, and business meaning. A CCTV or lending demo would swap only this crate. |
| Node | `crates/sthira-batcher` | A subsidiary node: pending changes, sealing batches, the off-ledger audit store. |
| Node | `crates/sthira-verify` | Recomputes leaves, roots and heads and compares them with the verifier's own ledger copy. |
| Demo only | `demo/demo-director` | Wires the parties together (rename the cast at the top of `src/world.rs`), auto-anchoring, the HTTP API (axum) with live updates over server-sent events, and the OpenAPI spec. |
| Demo only | `demo/ui` | React + Vite + TypeScript. API types are generated from the OpenAPI spec (`make api`), so a backend change breaks the UI build instead of the live demo. |

`test-vectors/hashing-v1.json` is produced by an independent Python implementation of the spec
(`test-vectors/generate.py`); `sthira-core` must reproduce every value.

### What is simplified

This is a presentation demo, not the build plan's backend. In particular:

- **No real Canton.** The ledger is an in-memory simulation that reproduces the behaviour the story
  relies on: each party keeps its own copy, every member co-signs, a fork or skipped sequence is
  refused, and archiving needs every signatory. The real system uses the Daml templates in the build plan.
- **No real Debezium or databases.** Changes are generated in memory in Debezium's event shape.
- **The hashing is real** and follows the build plan's hashing spec v1 exactly (RFC 8785 canonical JSON,
  32-byte salts, RFC 6962 Merkle trees, heads over `seq`, log positions, time window and event count).
- State is in memory and resets when the server restarts.
