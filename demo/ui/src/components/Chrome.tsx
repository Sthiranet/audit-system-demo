// Top bar, network strip and activity panel: always on screen.
import { useEffect, useRef, useState } from 'react';
import type { StateView } from '../api/client';
import { Hash, fmtTime, partyName, plural } from '../ui';
import logo from '../assets/logo.png';

export function TopBar(props: {
  auto: boolean;
  auditorOn: boolean;
  onAuto: (on: boolean) => void;
  onAuditor: () => void;
  onReset: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const reset = () => {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    window.clearTimeout(timer.current);
    setArmed(false);
    props.onReset();
  };
  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src={logo} alt="" />
        <span className="brand-name">Sthiranet</span>
        <span className="brand-sub">Group audit trail · live demo</span>
      </div>
      <div className="top-actions">
        <label className="switch" title="Each subsidiary captures a few changes and seals a batch every 10 seconds">
          <input type="checkbox" checked={props.auto} onChange={(e) => props.onAuto(e.target.checked)} />
          <span className="slider"></span>
          <span>Auto-anchor every 10 s</span>
        </label>
        <button className="btn btn-purple" disabled={props.auditorOn} onClick={props.onAuditor}>
          {props.auditorOn ? 'Auditor on network' : 'Add auditor'}
        </button>
        <button className="btn btn-ghost" onClick={reset}>
          {armed ? 'Click again to reset' : 'Reset demo'}
        </button>
      </div>
    </header>
  );
}

export function NetworkStrip({ s, selected, onSelect }: { s: StateView; selected: string; onSelect: (id: string) => void }) {
  const ids = s.subs.map((x) => x.id).join(', ');
  const held = s.subs.map((x) => `${x.id} ${x.hqCopy ? '✓' : '–'}`).join(' · ');
  const a = s.auditor;
  return (
    <section className="network" aria-label="Network">
      <div className="node hq">
        <div className="node-title">
          <span className="node-name" style={{ color: 'var(--gold)' }}>
            HQ <small>{s.hq.region}</small>
          </span>
        </div>
        <div className="node-line">
          <span className="k">Co-signs</span> every subsidiary anchor
        </div>
        <div className="node-line">
          <span className="k">Ledger copies</span> {ids}
        </div>
        <div className="node-line">
          <span className="k">Trails held</span> {held}
        </div>
      </div>
      <div className="link">
        <div className="sync-pill">
          Private
          <br />
          synchronizer
        </div>
        <div className="bar"></div>
        <div>hashes only</div>
      </div>
      {s.subs.map((x) => {
        const v = s.lastVerify[x.id];
        const light = v ? (v.ok ? 'ok' : 'bad') : '';
        const tip = v
          ? `Last verified by ${partyName(v.verifier)} at ${fmtTime(v.at)}: ${v.ok ? 'all batches match' : `mismatch from batch #${v.firstBadSeq}`}`
          : 'Not verified yet';
        return (
          <div
            key={x.id}
            className={`node sub ${selected === x.id ? 'selected' : ''}`}
            title={`Select ${x.id}`}
            onClick={() => onSelect(x.id)}
          >
            <div className="node-title">
              <span className="node-name">
                {x.id} <small>{x.region}</small>
              </span>
              <span className={`light ${light}`} title={tip}></span>
            </div>
            <div className="node-line">
              <span className="k">DB</span> {x.db}
            </div>
            <div className="node-line">
              <span className="k">Chain</span> #{x.lastSeq} · <Hash h={x.lastHead} cls="gold" />
            </div>
            <div className="node-line">
              <span className="k">Pending</span> {plural(x.pending, 'change')}
            </div>
          </div>
        );
      })}
      <div className="link">
        {a.enabled && (
          <>
            <div className="bar"></div>
            <div>co-signs</div>
          </>
        )}
      </div>
      {a.enabled ? (
        <div className="node auditor on">
          <div className="node-title">
            <span className="node-name" style={{ color: 'var(--purple)' }}>
              Auditor <small>{a.region}</small>
            </span>
          </div>
          <div className="node-line">
            <span className="k">Co-signs</span> new anchors
          </div>
          <div className="node-line">
            <span className="k">Ledger copies</span> {ids}
          </div>
          <div className="node-line">
            <span className="k">Verifies</span> HQ's trails
          </div>
        </div>
      ) : (
        <div className="node auditor off">
          <div className="node-title">
            <span className="node-name">Auditor</span>
          </div>
          <div className="node-line">Not on the network yet</div>
        </div>
      )}
    </section>
  );
}

export function ActivityPanel({ s }: { s: StateView }) {
  return (
    <aside className="activity">
      <h3>Activity</h3>
      <ol id="activity">
        {s.activity.map((x, i) => (
          <li key={`${x.at}-${i}`} className={x.level}>
            <div className="meta">
              <span className="who">{partyName(x.actor)}</span>
              <span>{fmtTime(x.at)}</span>
            </div>
            {x.text}
          </li>
        ))}
      </ol>
    </aside>
  );
}
