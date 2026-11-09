// 4 · Verify: HQ (or the auditor) recomputes every hash from the trail and compares it with the
// anchors on ITS OWN ledger copy.
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, type BatchCheck, type StateView, type SubView, type VerifyResponse } from '../api/client';
import { MerkleTree } from '../components/MerkleTree';
import { Hash, Sigs, fmtTime, partyName, plural, useRun } from '../ui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 420;

function steps(verifier: string, sub: SubView): { text: ReactNode; formula?: string }[] {
  const who = partyName(verifier);
  const n = sub.hqCopy ? plural(sub.hqCopy.count, 'record') : 'the records';
  return [
    { text: <>Read the trail HQ holds for {sub.id}: {n}</> },
    { text: <>Recompute every leaf from its record and salt</>, formula: 'H(0x00 ‖ salt ‖ event)' },
    { text: <>Rebuild each batch's Merkle tree up to its root</>, formula: 'H(0x01 ‖ left ‖ right)' },
    { text: <>Chain the heads, batch by batch, from genesis</>, formula: 'H(0x02 ‖ prev_head ‖ root ‖ meta)' },
    { text: <>Query the anchors for chain {sub.id} from <b>{who}'s own ledger copy</b></> },
    { text: <>Compare recomputed roots and heads with the anchored ones</> },
  ];
}

function Running({ verifier, sub, at }: { verifier: string; sub: SubView; at: number }) {
  return (
    <div className="banner warn">
      <div className="icon">⟳</div>
      <div>
        <div className="title">Recomputing…</div>
        <ol className="vsteps small">
          {steps(verifier, sub).map((s, i) => (
            <li key={i} className={i < at ? 'done' : i === at ? 'active' : ''}>
              <span className="dot">{i < at ? '✓' : i === at ? '●' : '○'}</span>
              <span>
                {s.text}
                {s.formula && <span className="formula-inline">{s.formula}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Explain({ b, v }: { b: BatchCheck; v: VerifyResponse }) {
  const who = partyName(v.verifier);
  if (b.ok) {
    return (
      <div className="explain">
        Batch #{b.seq}: the {plural(b.recomputed.eventCount, 'record')} in the trail hash to exactly the root and head
        that were co-signed when the batch was sealed. Nothing has changed since capture.
      </div>
    );
  }
  const parts: ReactNode[] = [];
  for (const x of b.leafIssues) {
    parts.push(
      <>
        <b>{x.key}</b> ({x.eventId}) no longer hashes to the leaf recorded when it was captured:{' '}
        <Hash h={x.recorded} cls="dim" /> → <Hash h={x.recomputed} cls="red" />. The difference travels up the tree and
        produces a different Merkle root.
      </>,
    );
  }
  if (!b.countMatch) {
    parts.push(
      <>
        The trail has <b>{b.recomputed.eventCount}</b> records for this batch, but the anchor committed to{' '}
        <b>{b.anchored.eventCount}</b>.
        {b.missingIndexes.length > 0 &&
          ` Leaf position ${b.missingIndexes.map((i) => `L${i + 1}`).join(', ')} is missing: a record was deleted.`}
      </>,
    );
  }
  if (!b.rootMatch && !b.leafIssues.length && b.countMatch) {
    parts.push(
      <>
        Every stored leaf hash looks consistent, because whoever changed the record recomputed it to cover their
        tracks. It makes no difference: the batch still produces a different Merkle root from the one co-signed on the
        ledger.
      </>,
    );
  }
  if (b.rootMatch && !b.headMatch) {
    parts.push(
      <>
        This batch's own records are intact, but its head no longer matches. Each head includes the head before it, so
        the change in batch #{v.firstBadSeq} breaks every head after it.
      </>,
    );
  }
  parts.push(
    <>
      {who} compared against its <b>own</b> ledger copy, so {v.chain} could not have adjusted the expected values.
    </>,
  );
  return (
    <div className="explain bad">
      {parts.map((p, i) => (
        <div key={i} style={{ marginTop: i ? 12 : 0 }}>
          {p}
        </div>
      ))}
    </div>
  );
}

function Detail({ v, seq }: { v: VerifyResponse; seq: number | null }) {
  const b = v.batches.find((x) => x.seq === seq) ?? v.batches[v.batches.length - 1];
  if (!b) return null;
  const who = partyName(v.verifier);
  return (
    <>
      <h3 style={{ marginTop: 18 }}>Batch #{b.seq}: recomputed vs anchored</h3>
      <div className="compare">
        <div className="side">
          <h4>Recomputed by {who} from the trail</h4>
          <MerkleTree
            key={`${v.chain}-${b.seq}`}
            tree={b.tree}
            labels={b.leaves.map((l) => l.key)}
            bad={new Set(b.leafIssues.map((x) => x.index))}
            rootBad={!b.rootMatch}
          />
          <div className="kv" style={{ marginTop: 8 }}>
            <span className="k">merkle_root</span>
            <span className="v">
              <Hash h={b.recomputed.root} cls={b.rootMatch ? 'green' : 'red'} n={16} />
            </span>
            <span className="k">head</span>
            <span className="v">
              <Hash h={b.recomputed.head} cls={b.headMatch ? 'green' : 'red'} n={16} />
            </span>
            <span className="k">event_count</span>
            <span className="v">{b.recomputed.eventCount}</span>
          </div>
        </div>
        <div className={`compare-mid ${b.ok ? 'ok' : 'bad'}`}>
          {b.ok ? '=' : '≠'}
          <small>{b.ok ? 'match' : 'mismatch'}</small>
        </div>
        <div className="side" style={{ borderColor: 'rgba(212,165,116,.5)' }}>
          <h4>Anchored on {who}'s ledger copy</h4>
          <div className="kv">
            <span className="k">merkle_root</span>
            <span className="v">
              <Hash h={b.anchored.root} cls="gold" n={16} />
            </span>
            <span className="k">head</span>
            <span className="v">
              <Hash h={b.anchored.head} cls="gold" n={16} />
            </span>
            <span className="k">event_count</span>
            <span className="v">{b.anchored.eventCount}</span>
            <span className="k">window</span>
            <span className="v">
              {fmtTime(b.anchored.fromTime)} → {fmtTime(b.anchored.toTime)}
            </span>
          </div>
          <div className="sigs">
            <Sigs list={b.anchored.signatories} />
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            Co-signed when the batch was sealed. No single party can change it.
          </p>
        </div>
      </div>
      <Explain b={b} v={v} />
    </>
  );
}

const Mark = ({ ok }: { ok: boolean }) => <span className={`mark ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '✕'}</span>;

function Result({ v, seq, setSeq }: { v: VerifyResponse; seq: number | null; setSeq: (s: number) => void }) {
  const n = v.batches.length;
  return (
    <>
      {v.ok ? (
        <div className="banner ok">
          <div className="icon">✓</div>
          <div>
            <div className="title">Trail verified: all {n} batches match the ledger</div>
            <div className="small">
              {plural(v.eventCount, 'record')} recomputed. Every Merkle root and every chained head equals the anchor
              co-signed by {v.members.map(partyName).join(', ')}.
            </div>
          </div>
        </div>
      ) : (
        <div className="banner bad">
          <div className="icon">✕</div>
          <div>
            <div className="title">Tamper detected: batch #{v.firstBadSeq ?? v.failedSeqs[0]} does not match its anchor</div>
            <div className="small">
              The trail was changed after it was anchored. {v.failedSeqs.length} of {n} batches fail: #
              {v.firstBadSeq ?? v.failedSeqs[0]} has a different Merkle root, and since every head includes the one
              before it, the later heads break too.
            </div>
          </div>
        </div>
      )}
      <div className="table-wrap" style={{ maxHeight: 300 }}>
        <table className="grid verify-table">
          <thead>
            <tr>
              <th>Batch</th>
              <th>Records (trail / anchor)</th>
              <th>Recomputed root</th>
              <th>Anchored root</th>
              <th></th>
              <th>Recomputed head</th>
              <th>Anchored head</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {v.batches.map((b, i) => (
              <tr
                key={b.seq}
                className={`${b.ok ? '' : 'bad'} ${b.seq === seq ? 'sel' : ''}`}
                style={{ animationDelay: `${(i * 0.12).toFixed(2)}s` }}
                onClick={() => setSeq(b.seq)}
              >
                <td className="mono">#{b.seq}</td>
                <td className="mono">
                  {b.recomputed.eventCount} / {b.anchored.eventCount} {!b.countMatch && <Mark ok={false} />}
                </td>
                <td>
                  <Hash h={b.recomputed.root} cls={b.rootMatch ? '' : 'red'} />
                </td>
                <td>
                  <Hash h={b.anchored.root} cls="gold" />
                </td>
                <td>
                  <Mark ok={b.rootMatch} />
                </td>
                <td>
                  <Hash h={b.recomputed.head} cls={b.headMatch ? '' : 'red'} />
                </td>
                <td>
                  <Hash h={b.anchored.head} cls="gold" />
                </td>
                <td>
                  <Mark ok={b.headMatch} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        Click a batch to compare it in detail.
      </p>
      <Detail v={v} seq={seq} />
    </>
  );
}

export function VerifyTab(props: {
  s: StateView;
  sub: SubView;
  onSelectSub: (id: string) => void;
  verifier: string;
  setVerifier: (v: string) => void;
  result: VerifyResponse | null;
  setResult: (v: VerifyResponse) => void;
  seq: number | null;
  setSeq: (s: number | null) => void;
}) {
  const { s, sub, result } = props;
  const verifier = props.verifier === 'AUDITOR' && !s.auditor.enabled ? 'HQ' : props.verifier;
  const qc = useQueryClient();
  const run = useRun();
  const [step, setStep] = useState<number | null>(null);

  const verify = () =>
    run(async () => {
      const total = steps(verifier, sub).length;
      setStep(0);
      try {
        for (let i = 1; i < total; i++) {
          await sleep(STEP_MS);
          setStep(i);
        }
        // Call the verifier only at the last step, so the activity log and the network light
        // don't reveal the result before the sequence reaches "Compare".
        const [v] = await Promise.all([api.verify(verifier, sub.id), sleep(STEP_MS)]);
        props.setResult(v);
        props.setSeq(v.firstBadSeq ?? (v.batches.length ? v.batches[v.batches.length - 1].seq : null));
        await qc.invalidateQueries();
      } finally {
        setStep(null);
      }
    });

  const lead =
    verifier === 'HQ' ? (
      <>
        HQ takes the audit trail <b>{sub.id} pushed upstream</b>, recomputes every leaf, Merkle root and head, and
        compares them with the anchors on <b>HQ's own ledger copy</b>. HQ does not have to trust {sub.id}'s numbers, and
        it never needed {sub.id}'s database.
      </>
    ) : (
      <>
        The auditor takes the audit trail <b>held by HQ</b> for {sub.id}, recomputes every hash, and compares it with
        the anchors on <b>the auditor's own ledger copy</b>. Neither HQ nor {sub.id} can change those anchors.
      </>
    );
  const shown = result && result.chain === sub.id && result.verifier === verifier;
  const copy = sub.hqCopy;
  return (
    <>
      <p className="lead">{lead}</p>
      <div className="toolbar">
        <div className="chips">
          <span className="label">Verifier</span>
          {(
            [
              ['HQ', 'HQ'],
              ['AUDITOR', 'Auditor'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`chip ${verifier === id ? 'active' : ''}`}
              disabled={id === 'AUDITOR' && !s.auditor.enabled}
              title={id === 'AUDITOR' && !s.auditor.enabled ? 'Add the auditor first' : undefined}
              onClick={() => props.setVerifier(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="chips">
          <span className="label">Chain</span>
          {s.subs.map((x) => (
            <button key={x.id} className={`chip ${sub.id === x.id ? 'active' : ''}`} onClick={() => props.onSelectSub(x.id)}>
              {x.id}
            </button>
          ))}
        </div>
        <button className="btn btn-teal" disabled={step !== null} onClick={verify}>
          Run verification
        </button>
        <span className="small muted">
          Trail held by HQ: {copy ? `${plural(copy.count, 'record')}, pushed ${fmtTime(copy.pushedAt)}` : 'none'}
        </span>
      </div>
      <div id="verify-result">
        {step !== null ? (
          <Running verifier={verifier} sub={sub} at={step} />
        ) : shown ? (
          <Result v={result} seq={props.seq} setSeq={props.setSeq} />
        ) : (
          <div className="empty">Run the verification to recompute the hashes.</div>
        )}
      </div>
    </>
  );
}
