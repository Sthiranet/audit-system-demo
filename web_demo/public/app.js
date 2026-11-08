'use strict';
// Sthiranet demo UI. Plain JS, no build step. Talks to the demo server's /api.

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (h, cls = '', n = 8) => (h ? `<span class="hash ${cls}" title="${esc(h)}">${esc(h.slice(0, n))}…</span>` : '<span class="muted">—</span>');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const json = (o) => esc(JSON.stringify(o, null, 2));
const opBadge = (op) => `<span class="op op-${op}">${op}</span>`;
const partyName = (p) => (p === 'AUDITOR' ? 'Auditor' : p);
const sigs = (list) => (list || []).map((p) => `<span class="sig ${p}">${partyName(p)}</span>`).join('');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const api = {
  async get(p) { return handle(await fetch(p)); },
  async post(p, b) { return handle(await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })); },
};
async function handle(r) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const UI = {
  state: null, tab: 'capture', sub: 'S1', busy: false,
  batch: null, batchFresh: false, pendingSig: '',
  ledgerParty: 'HQ', seenSeq: {}, rewrite: null, rewriteForm: { actor: 'S1', chain: 'S1', seq: 2 },
  trailWhere: 'sub', cover: false,
  verifier: 'HQ', verify: null, verifySeq: null,
};
const subState = (id = UI.sub) => UI.state.subs.find((s) => s.id === id);

function toast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3800);
}

// ───────────────────────────── Network strip + activity ─────────────────────────────
function renderNetwork() {
  const s = UI.state;
  const ids = s.subs.map((x) => x.id).join(', ');
  const held = s.subs.map((x) => `${x.id} ${x.hqCopy ? '✓' : '–'}`).join(' · ');
  const hq = `<div class="node hq">
      <div class="node-title"><span class="node-name" style="color:var(--gold)">HQ <small>${esc(s.hq.region)}</small></span></div>
      <div class="node-line"><span class="k">Co-signs</span> every subsidiary anchor</div>
      <div class="node-line"><span class="k">Ledger copies</span> ${ids}</div>
      <div class="node-line"><span class="k">Trails held</span> ${held}</div></div>`;
  const link = `<div class="link"><div class="sync-pill">Private<br>synchronizer</div><div class="bar"></div><div>hashes only</div></div>`;
  const subs = s.subs.map((x) => {
    const v = s.lastVerify[x.id];
    const light = v ? (v.ok ? 'ok' : 'bad') : '';
    const tip = v ? `Last verified by ${partyName(v.verifier)} at ${fmtTime(v.at)}: ${v.ok ? 'all batches match' : `mismatch from batch #${v.firstBadSeq}`}` : 'Not verified yet';
    return `<div class="node sub ${UI.sub === x.id ? 'selected' : ''}" data-act="select-sub" data-id="${x.id}" title="Select ${x.id}">
      <div class="node-title"><span class="node-name">${x.id} <small>${esc(x.region)}</small></span><span class="light ${light}" title="${esc(tip)}"></span></div>
      <div class="node-line"><span class="k">DB</span> ${esc(x.db)}</div>
      <div class="node-line"><span class="k">Chain</span> #${x.lastSeq} · ${H(x.lastHead, 'gold')}</div>
      <div class="node-line"><span class="k">Pending</span> ${plural(x.pending, 'change')}</div></div>`;
  }).join('');
  const a = s.auditor;
  const link2 = `<div class="link">${a.enabled ? '<div class="bar"></div><div>co-signs</div>' : ''}</div>`;
  const aud = a.enabled
    ? `<div class="node auditor on"><div class="node-title"><span class="node-name" style="color:var(--purple)">Auditor <small>${esc(a.region)}</small></span></div>
        <div class="node-line"><span class="k">Co-signs</span> new anchors</div>
        <div class="node-line"><span class="k">Ledger copies</span> ${ids}</div>
        <div class="node-line"><span class="k">Verifies</span> HQ's trails</div></div>`
    : `<div class="node auditor off"><div class="node-title"><span class="node-name">Auditor</span></div>
        <div class="node-line">Not on the network yet</div></div>`;
  $('#network').innerHTML = hq + link + subs + link2 + aud;
  $('#auto-toggle').checked = s.auto;
  const ab = $('#auditor-btn');
  ab.disabled = a.enabled;
  ab.textContent = a.enabled ? 'Auditor on network' : 'Add auditor';
}

function renderActivity() {
  $('#activity').innerHTML = UI.state.activity.map((x) => `<li class="${x.level}">
    <div class="meta"><span class="who">${esc(partyName(x.actor))}</span><span>${fmtTime(x.at)}</span></div>${esc(x.text)}</li>`).join('');
}

async function refreshState() {
  UI.state = await api.get('/api/state');
  renderNetwork();
  renderActivity();
}

// ───────────────────────────── Merkle tree drawing ─────────────────────────────
function treeSvg(tree, opt = {}) {
  const labels = opt.labels || [];
  const bad = opt.bad || new Set();
  const nw = 74, nh = 36, colW = 80, rowH = 66, padX = 4, padTop = 4, keyH = 18;
  if (!tree || tree.empty) {
    const w = 200;
    return `<div class="tree-wrap"><svg width="${w}" height="56" viewBox="0 0 ${w} 56">
      <g class="t-node root ${opt.rootBad ? 'bad' : ''}"><title>${tree ? tree.hash : ''}</title><rect x="${w / 2 - 60}" y="6" width="120" height="${nh}" rx="6"/>
      <text class="t-cap" x="${w / 2}" y="19" text-anchor="middle">ROOT · EMPTY BATCH</text>
      <text class="t-hash" x="${w / 2}" y="34" text-anchor="middle">${tree ? tree.hash.slice(0, 8) : ''}</text></g></svg></div>`;
  }
  const leaves = [];
  (function walk(n) { if (n.leaf !== undefined) leaves.push(n); else { walk(n.left); walk(n.right); } })(tree);
  const height = (n) => (n.leaf !== undefined ? 0 : 1 + Math.max(height(n.left), height(n.right)));
  const top = height(tree);
  const pos = new Map();
  (function place(n) {
    const y = padTop + (top - height(n)) * rowH;
    if (n.leaf !== undefined) pos.set(n, { x: padX + nw / 2 + leaves.indexOf(n) * colW, y });
    else { place(n.left); place(n.right); pos.set(n, { x: (pos.get(n.left).x + pos.get(n.right).x) / 2, y }); }
  })(tree);
  const isBad = (n) => (n.leaf !== undefined ? bad.has(n.leaf) : isBad(n.left) || isBad(n.right));
  const anim = (n) => (opt.animate ? `tree-node-appear" style="animation-delay:${(height(n) * 0.45 + (n.leaf !== undefined ? n.leaf * 0.06 : 0)).toFixed(2)}s` : '');
  let lines = '';
  let nodes = '';
  (function draw(n) {
    const p = pos.get(n);
    const isLeaf = n.leaf !== undefined;
    const isRoot = n === tree;
    const nBad = isBad(n) || (isRoot && opt.rootBad);
    if (!isLeaf) {
      for (const c of [n.left, n.right]) {
        const q = pos.get(c);
        lines += `<path class="t-line ${isBad(c) ? 'bad' : ''} ${anim(n)}" d="M${q.x},${q.y} C${q.x},${q.y - rowH * 0.4} ${p.x},${p.y + nh + rowH * 0.25} ${p.x},${p.y + nh}"/>`;
        draw(c);
      }
    }
    const cap = isRoot ? 'ROOT' : isLeaf ? `LEAF ${n.leaf + 1}` : 'NODE';
    const key = isLeaf && labels[n.leaf] ? `<text class="t-key ${nBad ? 'bad' : ''}" x="${p.x}" y="${p.y + nh + 13}" text-anchor="middle">${esc(labels[n.leaf])}</text>` : '';
    nodes += `<g class="t-node ${isLeaf ? 'leaf' : ''} ${isRoot ? 'root' : ''} ${nBad ? 'bad' : ''} ${anim(n)}"><title>${n.hash}</title>
      <rect x="${p.x - nw / 2}" y="${p.y}" width="${nw}" height="${nh}" rx="6"/>
      <text class="t-cap" x="${p.x}" y="${p.y + 13}" text-anchor="middle">${cap}</text>
      <text class="t-hash" x="${p.x}" y="${p.y + 28}" text-anchor="middle">${n.hash.slice(0, 8)}</text>${key}</g>`;
  })(tree);
  const w = padX * 2 + nw + (leaves.length - 1) * colW;
  const h = padTop + top * rowH + nh + keyH;
  return `<div class="tree-wrap"><svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;height:auto">${lines}${nodes}</svg></div>`;
}

function anchorCard(a) {
  return `<div class="anchor-card">
    <div class="anchor-title"><span>AuditAnchor · chain ${esc(a.chainId)} · #${a.seq}</span><span class="mono small muted">${esc(a.contractId)}</span></div>
    <div class="kv">
      <span class="k">seq</span><span class="v">${a.seq}</span>
      <span class="k">merkle_root</span><span class="v">${H(a.merkleRoot, 'gold', 16)}</span>
      <span class="k">prev_head</span><span class="v">${H(a.prevHead, 'dim', 16)} <span class="muted small">${a.seq === 1 ? '(genesis)' : `(head of #${a.seq - 1})`}</span></span>
      <span class="k">head</span><span class="v">${H(a.head, 'gold', 16)}</span>
      <span class="k">event_count</span><span class="v">${a.eventCount}</span>
      <span class="k">window</span><span class="v">${fmtTime(a.fromTime)} → ${fmtTime(a.toTime)}</span>
    </div>
    <div class="sigs">${sigs(a.signatories)}</div>
  </div>`;
}

// ───────────────────────────── 1 · Capture & batch ─────────────────────────────
function pendingHtml(list) {
  if (!list.length) return '<div class="empty">No pending changes. Capture some, or seal an empty batch: a quiet period is anchored too.</div>';
  return `<div class="evt-list">${list.map((p) => `<details class="evt">
    <summary>${opBadge(p.op)}<span><span class="evt-label">${esc(p.label)}</span><span class="evt-text">${esc(p.text)}</span></span><span class="muted small">${fmtTime(p.committedAt)}</span></summary>
    <div class="json-cols"><div><h4>Debezium change event</h4><pre>${json(p.raw)}</pre></div><div><h4>Normalised event (what gets hashed)</h4><pre>${json(p.event)}</pre></div></div>
  </details>`).join('')}</div>`;
}

function batchHtml(d) {
  if (!d) return '<div class="empty">No batches sealed yet.</div>';
  const b = d.batch;
  const nav = `<div class="batch-nav">
    <button class="btn btn-sm" data-act="batch-nav" data-seq="${d.seq - 1}" ${d.seq <= 1 ? 'disabled' : ''}>‹ prev</button>
    <span class="small muted">${d.seq} of ${d.totalBatches}</span>
    <button class="btn btn-sm" data-act="batch-nav" data-seq="${d.seq + 1}" ${d.seq >= d.totalBatches ? 'disabled' : ''}>next ›</button></div>`;
  const rows = b.items.map((it, i) => `<tr><td class="mono">L${i + 1}</td><td>${opBadge(it.op)}</td>
    <td><div class="evt-label">${esc(it.label)}</div><span class="evt-text">${esc(it.text)}</span></td>
    <td>${H(it.salt, 'dim')}</td><td>${H(it.leafHash)}</td></tr>`).join('');
  return `<div class="panel-head"><div><h2>Batch #${d.seq} · ${esc(d.chain)}</h2><p class="muted">Sealed ${fmtTime(b.sealedAt)} · ${plural(b.eventCount, 'event')}</p></div>${nav}</div>
    <div class="step"><div class="step-n">1</div><div class="step-body">
      <h3>Each change is salted and hashed into a leaf</h3>
      <div class="formula">leaf = <b>SHA-256</b>(0x00 ‖ salt ‖ event) · the salt stops anyone guessing an amount</div>
      ${b.items.length ? `<div class="table-wrap" style="max-height:230px"><table class="grid"><thead><tr><th>Leaf</th><th>Op</th><th>Change</th><th>Salt</th><th>Leaf hash</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">Empty batch. It is still anchored, so silence is visible on the ledger.</div>'}
    </div></div>
    <div class="step"><div class="step-n">2</div><div class="step-body">
      <h3>Leaves are paired and hashed up to one Merkle root</h3>
      <div class="formula">node = <b>SHA-256</b>(0x01 ‖ left ‖ right) · change any record and the root changes</div>
      ${treeSvg(b.tree, { labels: b.items.map((i) => i.key), animate: UI.batchFresh })}
    </div></div>
    <div class="step"><div class="step-n">3</div><div class="step-body">
      <h3>The root is anchored on the ledger and chained to the previous batch</h3>
      <div class="formula">head = <b>SHA-256</b>(0x02 ‖ prev_head ‖ merkle_root ‖ meta) · co-signed</div>
      ${anchorCard(d.anchor)}
    </div></div>`;
}

async function renderCapture() {
  const s = subState();
  const p = await api.get(`/api/pending/${UI.sub}`);
  if (!UI.batch || UI.batch.chain !== UI.sub) {
    UI.batch = s.lastSeq ? await api.get(`/api/batch/${UI.sub}/${s.lastSeq}`) : null;
  }
  UI.pendingSig = p.pending.map((x) => x.id).join();
  view.innerHTML = `
    <p class="lead"><b>${s.id}</b> runs its own ERP database (${esc(s.db)}) in <b>${esc(s.region)}</b>. Debezium captures every change from the database log.
      The node seals the changes into a batch, hashes the batch into one Merkle root and anchors that root on the ledger, co-signed with HQ. The records themselves stay in ${esc(s.region)}.</p>
    <div class="cols cols-capture">
      <div class="panel">
        <div class="panel-head"><div><h2>Captured changes · ${s.id}</h2><p class="muted">Waiting for the next batch. Click a row to see the raw event.</p></div></div>
        <div class="btn-row" style="align-items:center">
          <span class="small muted">Capture changes:</span>
          <button class="btn btn-sm" data-act="capture" data-n="1">+1</button>
          <button class="btn btn-sm" data-act="capture" data-n="5">+5</button>
          <button class="btn btn-sm" data-act="capture" data-n="10">+10</button>
        </div>
        <div id="pending">${pendingHtml(p.pending)}</div>
        <button id="seal-btn" class="btn btn-gold wide" data-act="seal">Seal batch #${s.lastSeq + 1} and anchor it</button>
      </div>
      <div class="panel" id="batch-panel">${batchHtml(UI.batch)}</div>
    </div>`;
}

async function refreshPending() {
  const p = await api.get(`/api/pending/${UI.sub}`);
  const sig = p.pending.map((x) => x.id).join();
  if (sig !== UI.pendingSig && $('#pending')) { $('#pending').innerHTML = pendingHtml(p.pending); UI.pendingSig = sig; }
  const btn = $('#seal-btn');
  if (btn) btn.textContent = `Seal batch #${subState().lastSeq + 1} and anchor it`;
}

// ───────────────────────────── 2 · Ledger ─────────────────────────────
function chainHtml(party, c) {
  const key = `${party}:${c.chainId}`;
  const seen = UI.seenSeq[key];
  UI.seenSeq[key] = c.lastSeq;
  const blocks = c.anchors.map((a) => `<div class="arrow">→</div>
    <div class="block ${seen !== undefined && a.seq > seen ? 'new' : ''}">
      <div class="block-title"><span>#${a.seq}</span><span class="muted small" style="font-weight:400">${plural(a.eventCount, 'event')}</span></div>
      <div class="row"><span class="k">root</span>${H(a.merkleRoot)}</div>
      <div class="row"><span class="k">head</span>${H(a.head, 'gold')}</div>
      <div class="row"><span class="k">prev</span>${H(a.prevHead, 'dim')}</div>
      <div class="sigs">${sigs(a.signatories)}</div></div>`).join('');
  return `<div class="chain">
    <div class="chain-head"><h3>Chain ${esc(c.chainId)} <span class="muted small" style="font-weight:400">· appended only by ${esc(c.submitter)} · members ${c.members.map(partyName).join(', ')}</span></h3>
      <span class="small muted">${plural(c.anchors.length, 'anchor')} · head ${H(c.lastHead, 'gold')}</span></div>
    <div class="chain-row"><div class="block genesis"><div class="block-title" style="color:var(--cream-3)">genesis</div><div class="row">${H(c.genesisHead, 'dim')}</div></div>${blocks}</div>
  </div>`;
}

function rewriteHtml() {
  const s = UI.state;
  const f = UI.rewriteForm;
  const actors = ['HQ', ...s.subs.map((x) => x.id), ...(s.auditor.enabled ? ['AUDITOR'] : [])];
  const opt = (list, v) => list.map((x) => `<option value="${x}" ${x === v ? 'selected' : ''}>${partyName(x)}</option>`).join('');
  const r = UI.rewrite;
  const result = !r ? '' : `<div class="banner bad"><div class="icon">✕</div><div>
      <div class="title">Rejected by the ledger</div>
      <div class="small">${esc(r.reason)}</div>
      ${r.required.length ? `<div class="sigs small">Needed: ${sigs(r.required)} &nbsp; Signed: ${sigs(r.signed)}</div>` : ''}</div></div>`;
  return `<h3>Try to rewrite history</h3>
    <p class="muted small" style="margin:4px 0 12px">To change or remove an anchor, someone has to archive it on the ledger. Pick who tries.</p>
    <div class="form-row">
      <label>Who<select id="rw-actor">${opt(actors, f.actor)}</select></label>
      <label>Chain<select id="rw-chain">${opt(s.subs.map((x) => x.id), f.chain)}</select></label>
      <label>Anchor #<input id="rw-seq" type="number" min="1" value="${esc(f.seq)}"></label>
      <button class="btn btn-danger" style="font-size:13px;padding:6px 14px" data-act="rewrite">Attempt to archive</button>
    </div>${result}`;
}

function syncHtml(d) {
  const rows = d.synchronizer.map((e) => `<tr><td class="mono">${fmtTime(e.at)}</td><td class="mono">${esc(e.updateId)}</td>
    <td>${e.recipients.map(partyName).join(', ')}</td><td class="mono"><span class="muted">encrypted · ${e.bytes} B ·</span> ${H(e.ciphertext, 'dim')}</td></tr>`).join('');
  return `<h3>What the synchronizer sees</h3>
    <p class="muted small" style="margin:4px 0 12px">Sthiranet runs the synchronizer. It orders and delivers encrypted messages between the nodes. It cannot read them, so it never sees a root, let alone a record.</p>
    <div class="table-wrap" style="max-height:260px"><table class="grid sync-table"><thead><tr><th>Time</th><th>Update</th><th>Delivered to</th><th>Payload</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function renderLedger() {
  const s = UI.state;
  if (UI.ledgerParty === 'AUDITOR' && !s.auditor.enabled) UI.ledgerParty = 'HQ';
  const d = await api.get(`/api/ledger/${UI.ledgerParty}`);
  const parties = ['HQ', ...s.subs.map((x) => x.id), 'AUDITOR'];
  const chips = parties.map((p) => `<button class="chip ${UI.ledgerParty === p ? 'active' : ''}" data-act="ledger-party" data-id="${p}" ${p === 'AUDITOR' && !s.auditor.enabled ? 'disabled' : ''}>${partyName(p)}</button>`).join('');
  const visible = new Set(d.chains.map((c) => c.chainId));
  const hidden = s.subs.map((x) => x.id).filter((id) => !visible.has(id));
  const hiddenNote = hidden.length && d.chains.length
    ? `<p class="small muted">Chains ${hidden.join(' and ')} are not on ${partyName(d.party)}'s node: a party only receives the contracts it is a stakeholder of.</p>` : '';
  const scrolls = [...document.querySelectorAll('.table-wrap')].map((x) => x.scrollTop);
  view.innerHTML = `
    <p class="lead">Each party runs its own node and keeps its <b>own copy</b> of the anchors it signed. The ledger holds <b>only fingerprints</b>:
      Merkle roots, chained heads, event counts and time windows. Journal entries and vendor records never leave their subsidiary's region.</p>
    <div class="toolbar"><div class="chips"><span class="label">Ledger stored on the node of:</span>${chips}</div></div>
    <div class="panel">${d.chains.map((c) => chainHtml(d.party, c)).join('') || '<div class="empty">This node holds no ledger copies.</div>'}${hiddenNote}</div>
    <div class="cols cols-2" style="margin-top:18px"><div class="panel">${rewriteHtml()}</div><div class="panel">${syncHtml(d)}</div></div>`;
  document.querySelectorAll('.chain-row').forEach((r) => { r.scrollLeft = r.scrollWidth; });
  document.querySelectorAll('.table-wrap').forEach((x, i) => { x.scrollTop = scrolls[i] || 0; });
}

// ───────────────────────────── 3 · Off-ledger audit trail ─────────────────────────────
async function renderTrail() {
  const s = subState();
  const d = await api.get(`/api/trail/${UI.trailWhere}/${UI.sub}`);
  const subChips = UI.state.subs.map((x) => `<button class="chip ${UI.sub === x.id ? 'active' : ''}" data-act="select-sub" data-id="${x.id}">${x.id}</button>`).join('');
  const whereChips = `<button class="chip ${UI.trailWhere === 'sub' ? 'active' : ''}" data-act="trail-where" data-id="sub">${s.id}'s audit store · ${esc(s.region)}</button>
    <button class="chip ${UI.trailWhere === 'hq' ? 'active' : ''}" data-act="trail-where" data-id="hq">HQ's received copy · ${esc(UI.state.hq.region)}</button>`;
  const note = UI.trailWhere === 'sub'
    ? `The full, structured audit trail, kept in ${s.id}'s own database in ${esc(s.region)}. The ledger holds only its fingerprints.`
    : (d.pushedAt ? `The copy ${s.id} pushed upstream to HQ at ${fmtTime(d.pushedAt)}. In tab 4, HQ checks it against its own ledger copy.` : `${s.id} has not pushed a trail to HQ yet.`);
  const rows = d.rows.map((r) => `<tr>
    <td class="mono">${esc(r.id)}</td><td class="mono">#${r.batchSeq} · L${r.index + 1}</td><td>${opBadge(r.op)}</td>
    <td><div class="evt-label">${esc(r.label)}</div><span class="evt-text">${esc(r.text)}</span></td>
    <td>${H(r.leafHash)}</td>
    <td style="white-space:nowrap"><button class="btn btn-danger" data-act="tamper" data-mode="edit" data-id="${esc(r.id)}">Alter</button>
      <button class="btn btn-danger" data-act="tamper" data-mode="delete" data-id="${esc(r.id)}">Delete</button></td></tr>`).join('');
  const scroll = $('.table-wrap') ? $('.table-wrap').scrollTop : 0;
  view.innerHTML = `
    <p class="lead">Off the ledger, each audit trail is stored as structured records in an ordinary database. That is where a corrupt employee or a bug can change history.
      Use <b>Alter</b> or <b>Delete</b> to play that part, then push the trail to HQ and verify it in tab 4.</p>
    <div class="toolbar">
      <div class="chips"><span class="label">Subsidiary</span>${subChips}</div>
      <div class="chips"><span class="label">Trail held in</span>${whereChips}</div>
    </div>
    <div class="panel">
      <div class="panel-head" style="margin-bottom:12px"><div><h2>${plural(d.rows.length, 'record')}</h2><p class="where-note">${note}</p></div>
        <div class="toolbar" style="margin:0">
          <label class="check"><input type="checkbox" id="cover" ${UI.cover ? 'checked' : ''}> When altering, also recompute the stored leaf hash (cover tracks)</label>
          ${UI.trailWhere === 'sub' ? `<button class="btn btn-gold" data-act="push">Push ${s.id}'s trail to HQ</button>` : ''}
        </div></div>
      ${d.rows.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Record</th><th>Batch · leaf</th><th>Op</th><th>Change</th><th>Leaf hash at capture</th><th>Simulate tampering</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">No records here yet.</div>'}
    </div>`;
  if ($('.table-wrap')) $('.table-wrap').scrollTop = scroll;
}

// ───────────────────────────── 4 · Verify ─────────────────────────────
function verifyExplain(b, v) {
  const who = partyName(v.verifier);
  if (b.ok) return `<div class="explain">Batch #${b.seq}: the ${plural(b.recomputed.eventCount, 'record')} in the trail hash to exactly the root and head that were co-signed when the batch was sealed. Nothing has changed since capture.</div>`;
  const parts = [];
  for (const x of b.leafIssues) {
    parts.push(`<b>${esc(x.key)}</b> (${esc(x.eventId)}) no longer hashes to the leaf recorded when it was captured: ${H(x.recorded, 'dim')} → ${H(x.recomputed, 'red')}. The difference travels up the tree and produces a different Merkle root.`);
  }
  if (!b.countMatch) {
    parts.push(`The trail has <b>${b.recomputed.eventCount}</b> records for this batch, but the anchor committed to <b>${b.anchored.eventCount}</b>.` +
      (b.missingIndexes.length ? ` Leaf position ${b.missingIndexes.map((i) => `L${i + 1}`).join(', ')} is missing: a record was deleted.` : ''));
  }
  if (!b.rootMatch && !b.leafIssues.length && b.countMatch) {
    parts.push('Every stored leaf hash looks consistent, because whoever changed the record recomputed it to cover their tracks. It makes no difference: the batch still produces a different Merkle root from the one co-signed on the ledger.');
  }
  if (b.rootMatch && !b.headMatch) {
    parts.push(`This batch's own records are intact, but its head no longer matches. Each head includes the head before it, so the change in batch #${v.firstBadSeq} breaks every head after it.`);
  }
  parts.push(`${who} compared against its <b>own</b> ledger copy, so ${v.chain} could not have adjusted the expected values.`);
  return `<div class="explain bad">${parts.join('<br><br>')}</div>`;
}

function verifyDetail(v) {
  const b = v.batches.find((x) => x.seq === UI.verifySeq) || v.batches[v.batches.length - 1];
  if (!b) return '';
  const who = partyName(v.verifier);
  return `<h3 style="margin-top:18px">Batch #${b.seq}: recomputed vs anchored</h3>
    <div class="compare">
      <div class="side"><h4>Recomputed by ${who} from the trail</h4>
        ${treeSvg(b.tree, { labels: b.leaves.map((l) => l.key), bad: new Set(b.leafIssues.map((x) => x.index)), rootBad: !b.rootMatch })}
        <div class="kv" style="margin-top:8px">
          <span class="k">merkle_root</span><span class="v">${H(b.recomputed.root, b.rootMatch ? 'green' : 'red', 16)}</span>
          <span class="k">head</span><span class="v">${H(b.recomputed.head, b.headMatch ? 'green' : 'red', 16)}</span>
          <span class="k">event_count</span><span class="v">${b.recomputed.eventCount}</span></div>
      </div>
      <div class="compare-mid ${b.ok ? 'ok' : 'bad'}">${b.ok ? '=' : '≠'}<small>${b.ok ? 'match' : 'mismatch'}</small></div>
      <div class="side" style="border-color:rgba(212,165,116,.5)"><h4>Anchored on ${who}'s ledger copy</h4>
        <div class="kv">
          <span class="k">merkle_root</span><span class="v">${H(b.anchored.root, 'gold', 16)}</span>
          <span class="k">head</span><span class="v">${H(b.anchored.head, 'gold', 16)}</span>
          <span class="k">event_count</span><span class="v">${b.anchored.eventCount}</span>
          <span class="k">window</span><span class="v">${fmtTime(b.anchored.fromTime)} → ${fmtTime(b.anchored.toTime)}</span></div>
        <div class="sigs">${sigs(b.anchored.signatories)}</div>
        <p class="small muted" style="margin-top:8px">Co-signed when the batch was sealed. No single party can change it.</p>
      </div>
    </div>
    ${verifyExplain(b, v)}`;
}

function verifyHtml(v) {
  const n = v.batches.length;
  const banner = v.ok
    ? `<div class="banner ok"><div class="icon">✓</div><div><div class="title">Trail verified: all ${n} batches match the ledger</div>
        <div class="small">${plural(v.eventCount, 'record')} recomputed. Every Merkle root and every chained head equals the anchor co-signed by ${v.members.map(partyName).join(', ')}.</div></div></div>`
    : `<div class="banner bad"><div class="icon">✕</div><div><div class="title">Tamper detected: batch #${v.firstBadSeq} does not match its anchor</div>
        <div class="small">The trail was changed after it was anchored. ${v.failedSeqs.length} of ${n} batches fail: #${v.firstBadSeq} has a different Merkle root, and since every head includes the one before it, the later heads break too.</div></div></div>`;
  const mark = (ok) => `<span class="mark ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'}</span>`;
  const rows = v.batches.map((b, i) => `<tr class="${b.ok ? '' : 'bad'} ${b.seq === UI.verifySeq ? 'sel' : ''}" data-act="verify-row" data-seq="${b.seq}" style="animation-delay:${(i * 0.12).toFixed(2)}s">
    <td class="mono">#${b.seq}</td>
    <td class="mono">${b.recomputed.eventCount} / ${b.anchored.eventCount} ${b.countMatch ? '' : mark(false)}</td>
    <td>${H(b.recomputed.root, b.rootMatch ? '' : 'red')}</td><td>${H(b.anchored.root, 'gold')}</td><td>${mark(b.rootMatch)}</td>
    <td>${H(b.recomputed.head, b.headMatch ? '' : 'red')}</td><td>${H(b.anchored.head, 'gold')}</td><td>${mark(b.headMatch)}</td></tr>`).join('');
  return `${banner}
    <div class="table-wrap" style="max-height:300px"><table class="grid verify-table"><thead><tr>
      <th>Batch</th><th>Records (trail / anchor)</th><th>Recomputed root</th><th>Anchored root</th><th></th><th>Recomputed head</th><th>Anchored head</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small muted" style="margin-top:6px">Click a batch to compare it in detail.</p>
    <div id="verify-detail">${verifyDetail(v)}</div>`;
}

function renderVerify() {
  const s = UI.state;
  if (UI.verifier === 'AUDITOR' && !s.auditor.enabled) UI.verifier = 'HQ';
  const sub = subState();
  const verChips = [['HQ', 'HQ'], ['AUDITOR', 'Auditor']].map(([id, label]) => `<button class="chip ${UI.verifier === id ? 'active' : ''}" data-act="verifier" data-id="${id}" ${id === 'AUDITOR' && !s.auditor.enabled ? 'disabled title="Add the auditor first"' : ''}>${label}</button>`).join('');
  const chainChips = s.subs.map((x) => `<button class="chip ${UI.sub === x.id ? 'active' : ''}" data-act="select-sub" data-id="${x.id}">${x.id}</button>`).join('');
  const lead = UI.verifier === 'HQ'
    ? `HQ takes the audit trail <b>${sub.id} pushed upstream</b>, recomputes every leaf, Merkle root and head, and compares them with the anchors on <b>HQ's own ledger copy</b>. HQ does not have to trust ${sub.id}'s numbers, and it never needed ${sub.id}'s database.`
    : `The auditor takes the audit trail <b>held by HQ</b> for ${sub.id}, recomputes every hash, and compares it with the anchors on <b>the auditor's own ledger copy</b>. Neither HQ nor ${sub.id} can change those anchors.`;
  const copy = sub.hqCopy;
  const shown = UI.verify && UI.verify.chain === UI.sub && UI.verify.verifier === UI.verifier;
  view.innerHTML = `<p class="lead">${lead}</p>
    <div class="toolbar">
      <div class="chips"><span class="label">Verifier</span>${verChips}</div>
      <div class="chips"><span class="label">Chain</span>${chainChips}</div>
      <button class="btn btn-teal" data-act="verify">Run verification</button>
      <span class="small muted">Trail held by HQ: ${copy ? `${plural(copy.count, 'record')}, pushed ${fmtTime(copy.pushedAt)}` : 'none'}</span>
    </div>
    <div id="verify-result">${shown ? verifyHtml(UI.verify) : '<div class="empty">Run the verification to recompute the hashes.</div>'}</div>`;
}

async function runVerify() {
  const sub = subState();
  $('#verify-result').innerHTML = `<div class="banner warn"><div class="icon">⟳</div><div><div class="title">Recomputing…</div>
    <div class="small">${sub.hqCopy ? plural(sub.hqCopy.count, 'record') : 'The trail'} → leaf hashes → Merkle roots → chained heads, then reading anchors from ${partyName(UI.verifier)}'s ledger copy</div></div></div>`;
  const [v] = await Promise.all([api.post('/api/verify', { verifier: UI.verifier, chain: UI.sub }), sleep(900)]);
  UI.verify = v;
  UI.verifySeq = v.firstBadSeq || (v.batches.length ? v.batches[v.batches.length - 1].seq : null);
  await refreshState();
  renderVerify();
}

// ───────────────────────────── Wiring ─────────────────────────────
async function renderView() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === UI.tab));
  if (UI.tab === 'capture') return renderCapture();
  if (UI.tab === 'ledger') return renderLedger();
  if (UI.tab === 'trail') return renderTrail();
  return renderVerify();
}

const actions = {
  async 'select-sub'(t) {
    if (UI.sub === t.dataset.id) return;
    UI.sub = t.dataset.id;
    UI.batch = null;
    UI.rewriteForm.chain = UI.sub;
    renderNetwork();
    await renderView();
  },
  async capture(t) {
    await api.post(`/api/capture/${UI.sub}`, { count: Number(t.dataset.n) });
    await refreshState();
    await refreshPending();
  },
  async seal(t) {
    t.disabled = true;
    UI.batch = await api.post(`/api/seal/${UI.sub}`);
    UI.batchFresh = true;
    await refreshState();
    await renderCapture();
    UI.batchFresh = false;
    // Bring the tree into view while it builds.
    const treeStep = document.querySelectorAll('#batch-panel .step')[1];
    if (treeStep) view.scrollTo({ top: treeStep.offsetTop - view.offsetTop - 12, behavior: 'smooth' });
  },
  async 'batch-nav'(t) {
    UI.batch = await api.get(`/api/batch/${UI.sub}/${t.dataset.seq}`);
    await renderCapture();
  },
  async 'ledger-party'(t) { UI.ledgerParty = t.dataset.id; await renderLedger(); },
  async rewrite() {
    const f = UI.rewriteForm;
    f.actor = $('#rw-actor').value; f.chain = $('#rw-chain').value; f.seq = $('#rw-seq').value;
    UI.rewrite = await api.post('/api/ledger/rewrite', { actor: f.actor, chain: f.chain, seq: Number(f.seq) });
    await refreshState();
    await renderLedger();
  },
  async 'trail-where'(t) { UI.trailWhere = t.dataset.id; await renderTrail(); },
  async push() {
    const r = await api.post(`/api/push/${UI.sub}`);
    await refreshState();
    toast(`${UI.sub} pushed ${plural(r.count, 'record')} to HQ`, 'info');
    await renderTrail();
  },
  async tamper(t) {
    const r = await api.post('/api/tamper', { where: UI.trailWhere, chain: UI.sub, eventId: t.dataset.id, mode: t.dataset.mode, cover: UI.cover });
    await refreshState();
    toast(`Tampered: ${r.description}`, 'warn');
    await renderTrail();
  },
  async verifier(t) { UI.verifier = t.dataset.id; renderVerify(); },
  verify: runVerify,
  async 'verify-row'(t) {
    UI.verifySeq = Number(t.dataset.seq);
    document.querySelectorAll('.verify-table tbody tr').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.seq) === UI.verifySeq));
    $('#verify-detail').innerHTML = verifyDetail(UI.verify);
  },
};

document.addEventListener('click', async (e) => {
  if (e.target.closest('#activity-toggle')) {
    const off = document.body.classList.toggle('no-activity');
    e.target.textContent = off ? 'Show activity' : 'Hide activity';
    return;
  }
  const tab = e.target.closest('#tabs button');
  if (tab) { UI.tab = tab.dataset.tab; await renderView(); view.scrollTop = 0; return; }
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled || !actions[t.dataset.act]) return;
  UI.busy = true;
  try { await actions[t.dataset.act](t); } catch (err) { toast(err.message); } finally { UI.busy = false; }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'cover') UI.cover = e.target.checked;
  if (e.target.id === 'rw-actor') UI.rewriteForm.actor = e.target.value;
  if (e.target.id === 'rw-chain') UI.rewriteForm.chain = e.target.value;
  if (e.target.id === 'rw-seq') UI.rewriteForm.seq = e.target.value;
});

$('#auto-toggle').addEventListener('change', async (e) => {
  try { await api.post('/api/auto', { on: e.target.checked }); await refreshState(); } catch (err) { toast(err.message); }
});

$('#auditor-btn').addEventListener('click', async () => {
  try {
    await api.post('/api/auditor');
    await refreshState();
    toast('Auditor added: it now holds a copy of every chain and co-signs new anchors', 'info');
    await renderView();
  } catch (err) { toast(err.message); }
});

$('#reset-btn').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = 'Click again to reset';
    setTimeout(() => { delete b.dataset.armed; b.textContent = 'Reset demo'; }, 3000);
    return;
  }
  delete b.dataset.armed;
  b.textContent = 'Reset demo';
  try {
    await api.post('/api/reset');
    Object.assign(UI, { batch: null, verify: null, verifySeq: null, rewrite: null, seenSeq: {}, sub: 'S1', trailWhere: 'sub', ledgerParty: 'HQ', verifier: 'HQ' });
    await refreshState();
    await renderView();
  } catch (err) { toast(err.message); }
});

// Background refresh: keeps the network strip, activity and open lists current (auto-anchor mode).
async function poll() {
  try {
    const st = await api.get('/api/state');
    const changed = !UI.state || st.version !== UI.state.version;
    UI.state = st;
    renderNetwork();
    renderActivity();
    if (changed && !UI.busy) {
      if (UI.tab === 'capture') await refreshPending();
      else if (UI.tab === 'ledger') await renderLedger();
      else if (UI.tab === 'trail') await renderTrail();
    }
  } catch {
    toast('Lost connection to the demo server');
  }
  setTimeout(poll, 1500);
}

refreshState().then(renderView).then(() => setTimeout(poll, 1500)).catch((e) => toast(e.message));
