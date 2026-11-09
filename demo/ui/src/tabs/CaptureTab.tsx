// 1 · Capture & batch: Debezium changes → salted leaves → Merkle root → AuditAnchor on the ledger.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, keys, type S, type SubView } from '../api/client';
import { MerkleTree } from '../components/MerkleTree';
import { AnchorCard, Hash, OpBadge, fmtTime, json, plural, useRun } from '../ui';

function PendingList({ list }: { list: S['PendingRow'][] }) {
  if (!list.length) {
    return (
      <div className="empty">
        No pending changes. Capture some, or seal an empty batch: a quiet period is anchored too.
      </div>
    );
  }
  return (
    <div className="evt-list">
      {list.map((p) => (
        <details className="evt" key={p.id}>
          <summary>
            <OpBadge op={p.op} />
            <span>
              <span className="evt-label">{p.label}</span>
              <span className="evt-text">{p.text}</span>
            </span>
            <span className="muted small">{fmtTime(p.committedAt)}</span>
          </summary>
          <div className="json-cols">
            <div>
              <h4>Debezium change event</h4>
              <pre>{json(p.raw)}</pre>
            </div>
            <div>
              <h4>Normalised event (what gets hashed)</h4>
              <pre>{json(p.event)}</pre>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

function BatchPanel({ d, fresh, onNav }: { d: S['BatchDetail']; fresh: boolean; onNav: (seq: number) => void }) {
  const b = d.batch;
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Bring the tree into view while it builds.
    if (fresh) treeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [fresh, d.seq]);
  return (
    <>
      <div className="panel-head">
        <div>
          <h2>
            Batch #{d.seq} · {d.chain}
          </h2>
          <p className="muted">
            Sealed {fmtTime(b.sealedAt)} · {plural(b.eventCount, 'event')}
          </p>
        </div>
        <div className="batch-nav">
          <button className="btn btn-sm" disabled={d.seq <= 1} onClick={() => onNav(d.seq - 1)}>
            ‹ prev
          </button>
          <span className="small muted">
            {d.seq} of {d.totalBatches}
          </span>
          <button className="btn btn-sm" disabled={d.seq >= d.totalBatches} onClick={() => onNav(d.seq + 1)}>
            next ›
          </button>
        </div>
      </div>
      <div className="step">
        <div className="step-n">1</div>
        <div className="step-body">
          <h3>Each change is salted and hashed into a leaf</h3>
          <div className="formula">
            leaf = <b>SHA-256</b>(0x00 ‖ salt ‖ event) · the 32-byte salt stops anyone guessing an amount
          </div>
          {b.items.length ? (
            <div className="table-wrap" style={{ maxHeight: 230 }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Leaf</th>
                    <th>Op</th>
                    <th>Change</th>
                    <th>Salt</th>
                    <th>Leaf hash</th>
                  </tr>
                </thead>
                <tbody>
                  {b.items.map((it, i) => (
                    <tr key={it.id}>
                      <td className="mono">L{i + 1}</td>
                      <td>
                        <OpBadge op={it.op} />
                      </td>
                      <td>
                        <div className="evt-label">{it.label}</div>
                        <span className="evt-text">{it.text}</span>
                      </td>
                      <td>
                        <Hash h={it.salt} cls="dim" />
                      </td>
                      <td>
                        <Hash h={it.leafHash} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">Empty batch. It is still anchored, so silence is visible on the ledger.</div>
          )}
        </div>
      </div>
      <div className="step" ref={treeRef}>
        <div className="step-n">2</div>
        <div className="step-body">
          <h3>Leaves are paired and hashed up to one Merkle root</h3>
          <div className="formula">
            node = <b>SHA-256</b>(0x01 ‖ left ‖ right) · change any record and the root changes
          </div>
          <MerkleTree key={`${d.chain}-${d.seq}`} tree={b.tree} labels={b.items.map((i) => i.key)} animate={fresh} />
        </div>
      </div>
      <div className="step">
        <div className="step-n">3</div>
        <div className="step-body">
          <h3>The root is anchored on the ledger and chained to the previous batch</h3>
          <div className="formula">
            head = <b>SHA-256</b>(0x02 ‖ prev_head ‖ merkle_root ‖ meta) · co-signed
          </div>
          <AnchorCard a={d.anchor} />
        </div>
      </div>
    </>
  );
}

export function CaptureTab(props: {
  sub: SubView;
  batchSeq: number | undefined;
  setBatchSeq: (seq: number) => void;
  freshSeq: number | null;
  setFreshSeq: (seq: number | null) => void;
}) {
  const { sub, batchSeq, setBatchSeq, freshSeq, setFreshSeq } = props;
  const qc = useQueryClient();
  const run = useRun();
  const [sealing, setSealing] = useState(false);
  const pending = useQuery({ queryKey: keys.pending(sub.id), queryFn: () => api.pending(sub.id) });

  // Open on the latest batch; after that, stay on whatever the presenter is looking at.
  useEffect(() => {
    if (batchSeq === undefined && sub.lastSeq > 0) setBatchSeq(sub.lastSeq);
  }, [batchSeq, sub.lastSeq, setBatchSeq]);
  const batch = useQuery({
    queryKey: keys.batch(sub.id, batchSeq ?? 0),
    queryFn: () => api.batch(sub.id, batchSeq!),
    enabled: batchSeq !== undefined,
    staleTime: Infinity, // a sealed batch never changes
  });

  const capture = (n: number) =>
    run(async () => {
      await api.capture(sub.id, n);
      await qc.invalidateQueries();
    });
  const seal = () =>
    run(async () => {
      setSealing(true);
      try {
        const d = await api.seal(sub.id);
        qc.setQueryData(keys.batch(sub.id, d.seq), d);
        setFreshSeq(d.seq);
        setBatchSeq(d.seq);
        await qc.invalidateQueries({ queryKey: keys.state });
        await qc.invalidateQueries({ queryKey: keys.pending(sub.id) });
      } finally {
        setSealing(false);
      }
    });
  const nav = (seq: number) => {
    setFreshSeq(null);
    setBatchSeq(seq);
  };

  return (
    <>
      <p className="lead">
        <b>{sub.id}</b> runs its own ERP database ({sub.db}) in <b>{sub.region}</b>. Debezium captures every change from
        the database log. The node seals the changes into a batch, hashes the batch into one Merkle root and anchors that
        root on the ledger, co-signed with HQ. The records themselves stay in {sub.region}.
      </p>
      <div className="cols cols-capture">
        <div className="panel" id="batch-panel">
          {batch.data ? (
            <BatchPanel d={batch.data} fresh={freshSeq === batch.data.seq} onNav={nav} />
          ) : (
            <div className="empty">No batches sealed yet.</div>
          )}
        </div>
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Captured changes · {sub.id}</h2>
              <p className="muted">Waiting for the next batch. Click a row to see the raw event.</p>
            </div>
          </div>
          <div className="btn-row" style={{ alignItems: 'center' }}>
            <span className="small muted">Capture changes:</span>
            {[1, 5, 10].map((n) => (
              <button key={n} className="btn btn-sm" onClick={() => capture(n)}>
                +{n}
              </button>
            ))}
          </div>
          <div id="pending">{pending.data && <PendingList list={pending.data.pending} />}</div>
          <button className="btn btn-gold wide" disabled={sealing} onClick={seal}>
            Seal batch #{sub.lastSeq + 1} and anchor it
          </button>
        </div>
      </div>
    </>
  );
}
