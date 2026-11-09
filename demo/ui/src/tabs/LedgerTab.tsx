// 2 · Ledger: each party's own copy of the chains, the rewrite attempt, and what the synchronizer sees.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';
import { api, keys, type ArchiveAttempt, type S, type StateView } from '../api/client';
import { Hash, Sigs, fmtTime, partyName, plural, useRun } from '../ui';

// Last seq seen per party:chain, so newly anchored blocks slide in. Survives tab switches.
const seenSeq = new Map<string, number>();
export const clearSeenSeq = () => seenSeq.clear();

function Chain({ party, c }: { party: string; c: S['ChainCopy'] }) {
  const key = `${party}:${c.chainId}`;
  const seen = seenSeq.get(key);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    seenSeq.set(key, c.lastSeq);
  });
  useLayoutEffect(() => {
    if (rowRef.current) rowRef.current.scrollLeft = rowRef.current.scrollWidth;
  }, [c.anchors.length]);
  return (
    <div className="chain">
      <div className="chain-head">
        <h3>
          Chain {c.chainId}{' '}
          <span className="muted small" style={{ fontWeight: 400 }}>
            · appended only by {c.submitter} · members {c.members.map(partyName).join(', ')}
          </span>
        </h3>
        <span className="small muted">
          {plural(c.anchors.length, 'anchor')} · head <Hash h={c.lastHead} cls="gold" />
        </span>
      </div>
      <div className="chain-row" ref={rowRef}>
        <div className="block genesis">
          <div className="block-title" style={{ color: 'var(--cream-3)' }}>
            genesis
          </div>
          <div className="row">
            <Hash h={c.genesisHead} cls="dim" />
          </div>
        </div>
        {c.anchors.map((a) => (
          <Fragment key={a.seq}>
            <div className="arrow">→</div>
            <div className={`block ${seen !== undefined && a.seq > seen ? 'new' : ''}`}>
              <div className="block-title">
                <span>#{a.seq}</span>
                <span className="muted small" style={{ fontWeight: 400 }}>
                  {plural(a.eventCount, 'event')}
                </span>
              </div>
              <div className="row">
                <span className="k">root</span>
                <Hash h={a.merkleRoot} />
              </div>
              <div className="row">
                <span className="k">head</span>
                <Hash h={a.head} cls="gold" />
              </div>
              <div className="row">
                <span className="k">prev</span>
                <Hash h={a.prevHead} cls="dim" />
              </div>
              <div className="sigs">
                <Sigs list={a.signatories} />
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export type RewriteForm = { actor: string; chain: string; seq: string };

function Rewrite(props: {
  s: StateView;
  form: RewriteForm;
  setForm: (f: RewriteForm) => void;
  result: ArchiveAttempt | null;
  onAttempt: () => void;
}) {
  const { s, form, setForm, result: r } = props;
  const actors = ['HQ', ...s.subs.map((x) => x.id), ...(s.auditor.enabled ? ['AUDITOR'] : [])];
  return (
    <>
      <h3>Try to rewrite history</h3>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>
        To change or remove an anchor, someone has to archive it on the ledger. Pick who tries.
      </p>
      <div className="form-row">
        <label>
          Who
          <select value={form.actor} onChange={(e) => setForm({ ...form, actor: e.target.value })}>
            {actors.map((x) => (
              <option key={x} value={x}>
                {partyName(x)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Chain
          <select value={form.chain} onChange={(e) => setForm({ ...form, chain: e.target.value })}>
            {s.subs.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Anchor #
          <input type="number" min={1} value={form.seq} onChange={(e) => setForm({ ...form, seq: e.target.value })} />
        </label>
        <button className="btn btn-danger" style={{ fontSize: 13, padding: '6px 14px' }} onClick={props.onAttempt}>
          Attempt to archive
        </button>
      </div>
      {r && (
        <div className="banner bad">
          <div className="icon">✕</div>
          <div>
            <div className="title">Rejected by the ledger</div>
            <div className="small">{r.reason}</div>
            {r.required.length > 0 && (
              <div className="sigs small">
                Needed: <Sigs list={r.required} /> &nbsp; Signed: <Sigs list={r.signed} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Synchronizer({ d }: { d: S['LedgerView'] }) {
  return (
    <>
      <h3>What the synchronizer sees</h3>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>
        Sthiranet runs the synchronizer. It orders and delivers encrypted messages between the nodes. It cannot read
        them, so it never sees a root, let alone a record.
      </p>
      <div className="table-wrap" style={{ maxHeight: 260 }}>
        <table className="grid sync-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Update</th>
              <th>Delivered to</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {d.synchronizer.map((e) => (
              <tr key={e.updateId}>
                <td className="mono">{fmtTime(e.at)}</td>
                <td className="mono">{e.updateId}</td>
                <td>{e.recipients.map(partyName).join(', ')}</td>
                <td className="mono">
                  <span className="muted">encrypted · {e.bytes} B ·</span> <Hash h={e.ciphertext} cls="dim" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function LedgerTab(props: {
  s: StateView;
  party: string;
  setParty: (p: string) => void;
  form: RewriteForm;
  setForm: (f: RewriteForm) => void;
  result: ArchiveAttempt | null;
  setResult: (r: ArchiveAttempt) => void;
}) {
  const { s, setParty } = props;
  const party = props.party === 'AUDITOR' && !s.auditor.enabled ? 'HQ' : props.party;
  const qc = useQueryClient();
  const run = useRun();
  const ledger = useQuery({ queryKey: keys.ledger(party), queryFn: () => api.ledger(party) });
  const d = ledger.data;
  const parties = ['HQ', ...s.subs.map((x) => x.id), 'AUDITOR'];

  const attempt = () =>
    run(async () => {
      const f = props.form;
      props.setResult(await api.rewrite(f.actor, f.chain, Number(f.seq)));
      await qc.invalidateQueries();
    });

  const visible = new Set(d?.chains.map((c) => c.chainId));
  const hidden = s.subs.map((x) => x.id).filter((id) => !visible.has(id));
  return (
    <>
      <p className="lead">
        Each party runs its own node and keeps its <b>own copy</b> of the anchors it signed. The ledger holds{' '}
        <b>only fingerprints</b>: Merkle roots, chained heads, event counts and time windows. Journal entries and vendor
        records never leave their subsidiary's region.
      </p>
      <div className="toolbar">
        <div className="chips">
          <span className="label">Ledger stored on the node of:</span>
          {parties.map((p) => (
            <button
              key={p}
              className={`chip ${party === p ? 'active' : ''}`}
              disabled={p === 'AUDITOR' && !s.auditor.enabled}
              onClick={() => setParty(p)}
            >
              {partyName(p)}
            </button>
          ))}
        </div>
      </div>
      <div className="panel">
        {d && d.chains.length > 0 ? (
          d.chains.map((c) => <Chain key={c.chainId} party={d.party} c={c} />)
        ) : (
          <div className="empty">This node holds no ledger copies.</div>
        )}
        {d && hidden.length > 0 && d.chains.length > 0 && (
          <p className="small muted">
            Chains {hidden.join(' and ')} are not on {partyName(d.party)}'s node: a party only receives the contracts it
            is a stakeholder of.
          </p>
        )}
      </div>
      <div className="cols cols-2" style={{ marginTop: 18 }}>
        <div className="panel">{d && <Synchronizer d={d} />}</div>
        <div className="panel">
          <Rewrite s={s} form={props.form} setForm={props.setForm} result={props.result} onAttempt={attempt} />
        </div>
      </div>
    </>
  );
}
