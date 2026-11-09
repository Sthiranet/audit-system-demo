"""Independent reference implementation of Sthiranet hashing spec v1, used to generate
hashing-v1.json. The Rust crate sthira-core must reproduce every value (see its vectors test).

Run: python3 -I test-vectors/generate.py > test-vectors/hashing-v1.json

JCS here is json.dumps with sorted keys and no whitespace. That equals RFC 8785 for these inputs
(strings, integers, null; keys in the Basic Multilingual Plane) but not for floats in general.
"""
import hashlib
import json


def jcs(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def h(*parts):
    d = hashlib.sha256()
    for p in parts:
        d.update(p)
    return d.hexdigest()


def leaf(salt, event):
    return h(b"\x00", bytes.fromhex(salt), jcs(event).encode())


def node(l, r):
    return h(b"\x01", bytes.fromhex(l), bytes.fromhex(r))


def split(n):
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def mth(leaves):
    if not leaves:
        return h(b"")
    if len(leaves) == 1:
        return leaves[0]
    k = split(len(leaves))
    return node(mth(leaves[:k]), mth(leaves[k:]))


def path(leaves, m):
    if len(leaves) == 1:
        return []
    k = split(len(leaves))
    if m < k:
        return path(leaves[:k], m) + [mth(leaves[k:])]
    return path(leaves[k:], m - k) + [mth(leaves[:k])]


def head(prev, root, meta):
    return h(b"\x02", bytes.fromhex(prev), bytes.fromhex(root), jcs(meta).encode())


def genesis(chain):
    return h(b"\x03", b"sthiranet/v1/genesis/", chain.encode())


def event(i):
    je = {
        "id": f"JE-{1001 + i}", "entry_date": "2026-11-09", "account": "6400",
        "description": "Freight and logistics", "amount": f"{1200 + i * 1111}.{i:02d}",
        "currency": "USD", "status": "posted", "modified_by": "erp_svc_s1",
    }
    before = None if i % 2 == 0 else dict(je, amount="999.99")
    return {
        "v": 1, "chain": "S1",
        "source": {"connector": "postgresql", "db": "erp_s1", "schema": "public",
                   "table": "journal_entries", "pos": f"0/1A3F{i:03X}", "tx": str(5000 + i)},
        "key": {"id": je["id"]}, "op": "insert" if before is None else "update",
        "before": before, "after": je,
        "actor": {"name": "erp_svc_s1", "kind": "service"},
        "committed_at": f"2026-11-09T10:00:0{i}.000000Z",
        "captured_at": f"2026-11-09T10:00:0{i}.250000Z",
    }


events = [event(i) for i in range(5)]
salts = [f"{i + 1:02x}" * 32 for i in range(5)]
leaves = [leaf(s, e) for s, e in zip(salts, events)]
g = genesis("S1")
root = mth(leaves)
meta = {"chain": "S1", "seq": 1, "from_pos": events[0]["source"]["pos"], "to_pos": events[-1]["source"]["pos"],
        "from_time": "2026-11-09T09:59:50.000000Z", "to_time": "2026-11-09T10:00:10.000000Z", "event_count": 5}
empty_meta = dict(meta, seq=2, from_pos=meta["to_pos"], from_time=meta["to_time"],
                  to_time="2026-11-09T10:00:20.000000Z", event_count=0)
h1 = head(g, root, meta)

print(json.dumps({
    "spec": "sthiranet hashing v1",
    "events": [{"salt": s, "event": e, "canonical": jcs(e), "leaf": l} for s, e, l in zip(salts, events, leaves)],
    "batch": {"leaves": leaves, "root": root, "proofs": [{"index": i, "path": path(leaves, i)} for i in range(5)]},
    "genesis": {"chain": "S1", "head": g},
    "heads": [
        {"prev_head": g, "root": root, "meta": meta, "canonical_meta": jcs(meta), "head": h1},
        {"prev_head": h1, "root": h(b""), "meta": empty_meta, "canonical_meta": jcs(empty_meta), "head": head(h1, h(b""), empty_meta)},
    ],
}, indent=2, ensure_ascii=False))
