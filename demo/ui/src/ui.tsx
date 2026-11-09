// Small presentational helpers shared by every tab.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { Anchor } from './api/client';

export const fmtTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
export const partyName = (p: string) => (p === 'AUDITOR' ? 'Auditor' : p);
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const json = (o: unknown) => JSON.stringify(o, null, 2);

export function Hash({ h, cls = '', n = 8 }: { h?: string | null; cls?: string; n?: number }) {
  if (!h) return <span className="muted">—</span>;
  return (
    <span className={`hash ${cls}`} title={h}>
      {h.slice(0, n)}…
    </span>
  );
}

export const OpBadge = ({ op }: { op: string }) => <span className={`op op-${op}`}>{op}</span>;

export const Sigs = ({ list }: { list?: string[] }) => (
  <>
    {(list ?? []).map((p) => (
      <span key={p} className={`sig ${p}`}>
        {partyName(p)}
      </span>
    ))}
  </>
);

export function AnchorCard({ a }: { a: Anchor }) {
  return (
    <div className="anchor-card">
      <div className="anchor-title">
        <span>
          AuditAnchor · chain {a.chainId} · #{a.seq}
        </span>
        <span className="mono small muted">{a.contractId}</span>
      </div>
      <div className="kv">
        <span className="k">seq</span>
        <span className="v">{a.seq}</span>
        <span className="k">merkle_root</span>
        <span className="v">
          <Hash h={a.merkleRoot} cls="gold" n={16} />
        </span>
        <span className="k">prev_head</span>
        <span className="v">
          <Hash h={a.prevHead} cls="dim" n={16} />{' '}
          <span className="muted small">{a.seq === 1 ? '(genesis)' : `(head of #${a.seq - 1})`}</span>
        </span>
        <span className="k">head</span>
        <span className="v">
          <Hash h={a.head} cls="gold" n={16} />
        </span>
        <span className="k">event_count</span>
        <span className="v">{a.eventCount}</span>
        <span className="k">log positions</span>
        <span className="v mono small">
          {a.fromPos || '—'} → {a.toPos || '—'}
        </span>
        <span className="k">window</span>
        <span className="v">
          {fmtTime(a.fromTime)} → {fmtTime(a.toTime)}
        </span>
      </div>
      <div className="sigs">
        <Sigs list={a.signatories} />
      </div>
    </div>
  );
}

// ── Toast ──
type ToastKind = 'error' | 'info' | 'warn';
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: ToastKind; show: boolean }>({ msg: '', kind: 'error', show: false });
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((msg: string, kind: ToastKind = 'error') => {
    setT({ msg, kind, show: true });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT((x) => ({ ...x, show: false })), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div id="toast" role="status" className={`${t.kind} ${t.show ? 'show' : ''}`}>
        {t.msg}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an action so a failure shows as a toast instead of an unhandled rejection. */
export function useRun() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        return undefined;
      }
    },
    [toast],
  );
}
