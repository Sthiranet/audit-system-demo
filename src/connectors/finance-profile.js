'use strict';
// Connector layer · finance record profile.
// 1. FinanceSource stands in for a subsidiary's ERP database plus Debezium: it changes rows in
//    journal_entries and vendors and emits Debezium-shaped change events (schemas off).
// 2. normalize() turns a Debezium event into the event that gets hashed.
// 3. describe() gives each change a business meaning ("posted entry amended", "vendor bank account changed").
// Another industry (lending, CCTV hashes, pharma batches) would get its own profile; the kernel and node don't change.

const VENDOR_NAMES = [
  'Northwind Supplies', 'Kestrel Logistics', 'Bluegate Components', 'Orchid Packaging',
  'Meridian Freight', 'Saltmarsh Chemicals', 'Ironleaf Tooling', 'Copperline Electricals',
  'Harbourview Services', 'Granite Ridge Metals', 'Silverfern Textiles', 'Lumen Office Systems',
  'Redcliff Engineering', 'Tidewater Imports', 'Brightpath Consulting', 'Cobalt Warehousing',
];
const ACCOUNTS = [
  ['4000', 'Revenue · product sales'], ['4100', 'Revenue · services'], ['5000', 'Cost of goods sold'],
  ['6100', 'Salaries and wages'], ['6200', 'Rent and facilities'], ['6400', 'Freight and logistics'],
  ['1500', 'Capital expenditure'], ['2100', 'Intercompany payable · HQ'],
];

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const fmt = (s) => Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bankAccount = () => `ACCT ${rand(1000, 9999)}-${rand(1000, 9999)}-${rand(1000, 9999)}`;
const taxId = () => `TX-${rand(100000, 999999)}`;

class FinanceSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.jes = new Map();
    this.vendors = new Map();
    this.nextJe = 1001;
    this.nextVendor = 201;
    this.pos = cfg.connector === 'oracle' ? 48210000 : 0x1a3f000;
    this.tx = rand(5000, 9000);
    this.service = `erp_svc_${cfg.id.toLowerCase()}`;
    for (let i = 0; i < 4; i++) this._newVendor(); // master data that existed before capture started
  }

  _newVendor() {
    const used = new Set([...this.vendors.values()].map((v) => v.name));
    const free = VENDOR_NAMES.filter((n) => !used.has(n));
    const id = `V-${this.nextVendor++}`;
    const row = { id, name: free.length ? pick(free) : `Vendor ${id}`, bank_account: bankAccount(), tax_id: taxId(), status: 'active', modified_by: this.service };
    this.vendors.set(id, row);
    return row;
  }

  _position() {
    this.pos += rand(40, 400);
    return this.cfg.connector === 'oracle' ? { scn: String(this.pos) } : { lsn: `0/${this.pos.toString(16).toUpperCase()}` };
  }

  _kind() {
    const r = Math.random();
    if (r < 0.42 || this.jes.size === 0) return 'je-posted';
    if (r < 0.58) return 'je-amended';
    if (r < 0.70) return 'vendor-created';
    if (r < 0.88) return 'vendor-bank-change';
    return 'vendor-status-change';
  }

  // Applies one business change and returns the Debezium change event for it.
  next(ts) {
    const kind = this._kind();
    let table, op, before = null, row;
    if (kind === 'je-posted') {
      const [account, description] = pick(ACCOUNTS);
      row = { id: `JE-${this.nextJe++}`, entry_date: new Date(ts).toISOString().slice(0, 10), account, description,
        amount: money(rand(1200, 95000) + rand(0, 99) / 100), currency: this.cfg.currency, status: 'posted', modified_by: this.service };
      this.jes.set(row.id, row);
      table = 'journal_entries'; op = 'c';
    } else if (kind === 'je-amended') {
      row = pick([...this.jes.values()]);
      before = { ...row };
      const factor = 1 + pick([-1, 1]) * rand(1, 8) / 100;
      row.amount = money(parseFloat(row.amount) * factor);
      table = 'journal_entries'; op = 'u';
    } else if (kind === 'vendor-created') {
      row = this._newVendor();
      table = 'vendors'; op = 'c';
    } else if (kind === 'vendor-bank-change') {
      row = pick([...this.vendors.values()]);
      before = { ...row };
      row.bank_account = bankAccount();
      table = 'vendors'; op = 'u';
    } else {
      row = pick([...this.vendors.values()]);
      before = { ...row };
      row.status = row.status === 'active' ? 'blocked' : 'active';
      table = 'vendors'; op = 'u';
    }
    const oracle = this.cfg.connector === 'oracle';
    return {
      before,
      after: { ...row },
      source: {
        version: '3.7.0.Final', connector: this.cfg.connector, name: `erp_${this.cfg.id.toLowerCase()}`,
        ts_ms: ts, db: oracle ? 'ERPPDB' : `erp_${this.cfg.id.toLowerCase()}`, schema: oracle ? 'ERP' : 'public',
        table, txId: String(this.tx++), ...this._position(),
      },
      op,
      ts_ms: ts + rand(40, 900),
      transaction: null,
    };
  }
}

function normalize(raw, chainId) {
  const row = raw.after || raw.before;
  return {
    v: 1,
    chain: chainId,
    source: { connector: raw.source.connector, db: raw.source.db, table: raw.source.table, pos: raw.source.lsn || raw.source.scn, tx: raw.source.txId },
    key: { id: row.id },
    op: { c: 'insert', u: 'update', d: 'delete' }[raw.op],
    before: raw.before ? { ...raw.before } : null,
    after: raw.after ? { ...raw.after } : null,
    actor: { name: row.modified_by, kind: String(row.modified_by).startsWith('erp_svc') ? 'service' : 'user' },
    committed_at: new Date(raw.source.ts_ms).toISOString(),
    captured_at: new Date(raw.ts_ms).toISOString(),
  };
}

function describe(ev) {
  const a = ev.after || {};
  const b = ev.before || {};
  if (ev.source.table === 'journal_entries') {
    if (ev.op === 'insert') return { kind: 'je-posted', label: 'Journal entry posted', text: `${a.id} · ${a.description} · ${fmt(a.amount)} ${a.currency}` };
    if (b.amount !== a.amount) return { kind: 'je-amended', label: 'Posted entry amended', text: `${a.id} · ${fmt(b.amount)} → ${fmt(a.amount)} ${a.currency}` };
    return { kind: 'je-updated', label: 'Journal entry updated', text: `${a.id} · ${fmt(a.amount)} ${a.currency}` };
  }
  if (ev.op === 'insert') return { kind: 'vendor-created', label: 'Vendor created', text: `${a.id} · ${a.name} · ${a.bank_account}` };
  if (b.bank_account !== a.bank_account) return { kind: 'vendor-bank-change', label: 'Vendor bank account changed', text: `${a.id} · ${b.bank_account} → ${a.bank_account}` };
  if (b.status !== a.status) return { kind: 'vendor-status-change', label: 'Vendor status changed', text: `${a.id} · ${b.status} → ${a.status}` };
  return { kind: 'vendor-updated', label: 'Vendor updated', text: `${a.id} · ${a.name}` };
}

// Presenter action: what a corrupt employee (or a bug) does to a stored audit record.
function tamper(ev) {
  const a = ev.after;
  if (ev.source.table === 'journal_entries') {
    const old = a.amount;
    const v = parseFloat(old);
    a.amount = money(v >= 10000 ? v / 10 : v * 10);
    return `${a.id}: amount ${fmt(old)} → ${fmt(a.amount)} ${a.currency}`;
  }
  const old = a.bank_account;
  a.bank_account = old === 'ACCT 9999-0042-7731' ? 'ACCT 9999-0042-7732' : 'ACCT 9999-0042-7731';
  return `${a.id}: bank account ${old} → ${a.bank_account}`;
}

module.exports = { FinanceSource, normalize, describe, tamper };
