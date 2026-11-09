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

1. In Render: **New → Blueprint**, pick the repository. Render reads `render.yaml` and creates the
   `sthiranet-demo` service on the free plan.
2. Share the `https://sthiranet-demo-….onrender.com` link once the first deploy finishes.

To try the image locally: `docker build -t sthiranet-demo . && docker run --rm -p 3000:3000 sthiranet-demo`.
For a temporary live session use `cloudflared tunnel --url http://localhost:3000`.

### What is simplified

This is a presentation demo, not the build plan's backend. In particular:

- **No real Canton.** The ledger is an in-memory simulation that reproduces the behaviour the story
  relies on: each party keeps its own copy, every member co-signs, a fork or skipped sequence is
  refused, and archiving needs every signatory. The real system uses the Daml templates in the build plan.
- **No real Debezium or databases.** Changes are generated in memory in Debezium's event shape.
- **The hashing is real** and follows the build plan's hashing spec v1 exactly (RFC 8785 canonical JSON,
  32-byte salts, RFC 6962 Merkle trees, heads over `seq`, log positions, time window and event count).
- State is in memory and resets when the server restarts.
