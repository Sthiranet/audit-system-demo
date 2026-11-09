// 3 · Off-ledger audit trail: the structured records, where a corrupt employee or a bug can change history.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, keys, type StateView, type SubView, type TrailHolder } from '../api/client';
import { Hash, OpBadge, fmtTime, plural, useRun, useToast } from '../ui';

export function TrailTab(props: {
  s: StateView;
  sub: SubView;
  onSelectSub: (id: string) => void;
  where: TrailHolder;
  setWhere: (w: TrailHolder) => void;
  cover: boolean;
  setCover: (c: boolean) => void;
}) {
  const { s, sub, where, cover } = props;
  const qc = useQueryClient();
  const run = useRun();
  const toast = useToast();
  const trail = useQuery({ queryKey: keys.trail(where, sub.id), queryFn: () => api.trail(where, sub.id) });
  const d = trail.data;

  const push = () =>
    run(async () => {
      const r = await api.push(sub.id);
      toast(`${sub.id} pushed ${plural(r.count, 'record')} to HQ`, 'info');
      await qc.invalidateQueries();
    });
  const tamper = (eventId: string, mode: 'edit' | 'delete') =>
    run(async () => {
      const r = await api.tamper({ where, chain: sub.id, eventId, mode, cover });
      toast(`Tampered: ${r.description}`, 'warn');
      await qc.invalidateQueries();
    });

  const note =
    where === 'sub'
      ? `The full, structured audit trail, kept in ${sub.id}'s own database in ${sub.region}. The ledger holds only its fingerprints.`
      : d?.pushedAt
        ? `The copy ${sub.id} pushed upstream to HQ at ${fmtTime(d.pushedAt)}. In tab 4, HQ checks it against its own ledger copy.`
        : `${sub.id} has not pushed a trail to HQ yet.`;

  return (
    <>
      <p className="lead">
        Off the ledger, each audit trail is stored as structured records in an ordinary database. That is where a
        corrupt employee or a bug can change history. Use <b>Alter</b> or <b>Delete</b> to play that part, then push
        the trail to HQ and verify it in tab 4.
      </p>
      <div className="toolbar">
        <div className="chips">
          <span className="label">Subsidiary</span>
          {s.subs.map((x) => (
            <button key={x.id} className={`chip ${sub.id === x.id ? 'active' : ''}`} onClick={() => props.onSelectSub(x.id)}>
              {x.id}
            </button>
          ))}
        </div>
        <div className="chips">
          <span className="label">Trail held in</span>
          <button className={`chip ${where === 'sub' ? 'active' : ''}`} onClick={() => props.setWhere('sub')}>
            {sub.id}'s audit store · {sub.region}
          </button>
          <button className={`chip ${where === 'hq' ? 'active' : ''}`} onClick={() => props.setWhere('hq')}>
            HQ's received copy · {s.hq.region}
          </button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head" style={{ marginBottom: 12 }}>
          <div>
            <h2>{plural(d?.rows.length ?? 0, 'record')}</h2>
            <p className="where-note">{note}</p>
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <label className="check">
              <input type="checkbox" checked={cover} onChange={(e) => props.setCover(e.target.checked)} /> When
              altering, also recompute the stored leaf hash (cover tracks)
            </label>
            {where === 'sub' && (
              <button className="btn btn-gold" onClick={push}>
                Push {sub.id}'s trail to HQ
              </button>
            )}
          </div>
        </div>
        {d && d.rows.length > 0 ? (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Batch · leaf</th>
                  <th>Op</th>
                  <th>Change</th>
                  <th>Leaf hash at capture</th>
                  <th>Simulate tampering</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono">
                      #{r.batchSeq} · L{r.index + 1}
                    </td>
                    <td>
                      <OpBadge op={r.op} />
                    </td>
                    <td>
                      <div className="evt-label">{r.label}</div>
                      <span className="evt-text">{r.text}</span>
                    </td>
                    <td>
                      <Hash h={r.leafHash} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-danger" onClick={() => tamper(r.id, 'edit')}>
                        Alter
                      </button>{' '}
                      <button className="btn btn-danger" onClick={() => tamper(r.id, 'delete')}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No records here yet.</div>
        )}
      </div>
    </>
  );
}
