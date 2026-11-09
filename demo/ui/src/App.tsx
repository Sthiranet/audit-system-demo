import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, keys, type ArchiveAttempt, type TrailHolder, type VerifyResponse } from './api/client';
import { ActivityPanel, NetworkStrip, TopBar } from './components/Chrome';
import { CaptureTab } from './tabs/CaptureTab';
import { LedgerTab, clearSeenSeq, type RewriteForm } from './tabs/LedgerTab';
import { TrailTab } from './tabs/TrailTab';
import { VerifyTab } from './tabs/VerifyTab';
import { useRun, useToast } from './ui';

type Tab = 'capture' | 'ledger' | 'trail' | 'verify';
const TABS: [Tab, string][] = [
  ['capture', 'Capture & batch'],
  ['ledger', 'Ledger'],
  ['trail', 'Off-ledger audit trail'],
  ['verify', 'Verify'],
];

/** Live updates: demo-director pushes the state version over SSE; any change refetches what is on screen. */
function useLiveUpdates() {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let last: string | null = null;
    es.addEventListener('version', (e) => {
      setConnected(true);
      const v = (e as MessageEvent<string>).data;
      if (last !== null && v !== last) void qc.invalidateQueries();
      last = v;
    });
    es.onerror = () => setConnected(false); // the browser reconnects by itself; polling covers the gap
    return () => es.close();
  }, [qc]);
  return connected;
}

export function App() {
  const qc = useQueryClient();
  const run = useRun();
  const toast = useToast();
  const live = useLiveUpdates();
  const state = useQuery({ queryKey: keys.state, queryFn: api.state, refetchInterval: live ? false : 1500 });

  const [tab, setTab] = useState<Tab>('capture');
  const [subId, setSubId] = useState('S1');
  const [batchSel, setBatchSel] = useState<Record<string, number | undefined>>({});
  const [freshSeq, setFreshSeq] = useState<number | null>(null);
  const [ledgerParty, setLedgerParty] = useState('HQ');
  const [rewriteForm, setRewriteForm] = useState<RewriteForm>({ actor: 'S1', chain: 'S1', seq: '2' });
  const [rewriteResult, setRewriteResult] = useState<ArchiveAttempt | null>(null);
  const [trailWhere, setTrailWhere] = useState<TrailHolder>('sub');
  const [cover, setCover] = useState(false);
  const [verifier, setVerifier] = useState('HQ');
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [verifySeq, setVerifySeq] = useState<number | null>(null);
  const [hideActivity, setHideActivity] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('no-activity', hideActivity);
  }, [hideActivity]);
  useEffect(() => {
    if (state.isError) toast('Lost connection to the demo server');
  }, [state.isError, state.errorUpdatedAt, toast]);

  const selectSub = useCallback(
    (id: string) => {
      if (id === subId) return;
      setSubId(id);
      setBatchSel((b) => ({ ...b, [id]: undefined })); // reopen on that chain's latest batch
      setFreshSeq(null);
      setRewriteForm((f) => ({ ...f, chain: id }));
    },
    [subId],
  );
  const setBatchSeq = useCallback((seq: number) => setBatchSel((b) => ({ ...b, [subId]: seq })), [subId]);

  const s = state.data;
  if (!s) {
    return <div className="empty" style={{ margin: 40 }}>{state.isError ? 'Cannot reach the demo server.' : 'Loading…'}</div>;
  }
  const sub = s.subs.find((x) => x.id === subId) ?? s.subs[0];

  const onAuto = (on: boolean) =>
    run(async () => {
      qc.setQueryData(keys.state, await api.setAuto(on));
    });
  const onAuditor = () =>
    run(async () => {
      qc.setQueryData(keys.state, await api.addAuditor());
      toast('Auditor added: it now holds a copy of every chain and co-signs new anchors', 'info');
      await qc.invalidateQueries();
    });
  const onReset = () =>
    run(async () => {
      qc.setQueryData(keys.state, await api.reset());
      clearSeenSeq();
      setSubId('S1');
      setBatchSel({});
      setFreshSeq(null);
      setLedgerParty('HQ');
      setRewriteResult(null);
      setTrailWhere('sub');
      setVerifier('HQ');
      setVerifyResult(null);
      setVerifySeq(null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'state' });
      await qc.invalidateQueries();
    });

  return (
    <>
      <TopBar auto={s.auto} auditorOn={s.auditor.enabled} onAuto={onAuto} onAuditor={onAuditor} onReset={onReset} />
      <div className="main">
        <section className="workspace">
          <nav className="tabs">
            {TABS.map(([id, label], i) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                <b>{i + 1}</b> {label}
              </button>
            ))}
            <span className="tabs-spacer"></span>
            <button
              className="activity-toggle"
              title="Show or hide the activity panel"
              onClick={() => setHideActivity((h) => !h)}
            >
              {hideActivity ? 'Show activity' : 'Hide activity'}
            </button>
          </nav>
          <div id="view" className="view">
            {tab === 'capture' && (
              <CaptureTab
                key={sub.id}
                sub={sub}
                batchSeq={batchSel[sub.id]}
                setBatchSeq={setBatchSeq}
                freshSeq={freshSeq}
                setFreshSeq={setFreshSeq}
              />
            )}
            {tab === 'ledger' && (
              <LedgerTab
                s={s}
                party={ledgerParty}
                setParty={setLedgerParty}
                form={rewriteForm}
                setForm={setRewriteForm}
                result={rewriteResult}
                setResult={setRewriteResult}
              />
            )}
            {tab === 'trail' && (
              <TrailTab
                s={s}
                sub={sub}
                onSelectSub={selectSub}
                where={trailWhere}
                setWhere={setTrailWhere}
                cover={cover}
                setCover={setCover}
              />
            )}
            {tab === 'verify' && (
              <VerifyTab
                s={s}
                sub={sub}
                onSelectSub={selectSub}
                verifier={verifier}
                setVerifier={setVerifier}
                result={verifyResult}
                setResult={setVerifyResult}
                seq={verifySeq}
                setSeq={setVerifySeq}
              />
            )}
          </div>
        </section>
        <ActivityPanel s={s} />
      </div>
      <NetworkStrip s={s} selected={sub.id} onSelect={selectSub} />
    </>
  );
}
