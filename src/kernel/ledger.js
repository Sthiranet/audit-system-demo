'use strict';
// Kernel · a stand-in for Canton. Not a blockchain: just enough behaviour to tell the story.
//  - Every party runs a participant node that keeps its OWN copy of the contracts it is a stakeholder of.
//  - An AuditChain belongs to its members (subsidiary + HQ, later the auditor). Only the subsidiary appends.
//  - An append succeeds only if EVERY member's node agrees it continues the chain (seq + prevHead),
//    and the resulting AuditAnchor is signed by every member and stored on every member's node.
//  - Archiving (rewriting) an anchor needs every signatory, so no single party can do it.
//  - The synchronizer only orders encrypted envelopes: it sees recipients and sizes, never contents.
const crypto = require('crypto');

class LedgerError extends Error {}

const clone = (o) => JSON.parse(JSON.stringify(o));
const rid = (prefix) => `${prefix}${crypto.randomBytes(5).toString('hex')}`;

class Ledger {
  constructor() {
    this.parties = new Map(); // party -> { id, chains: Map(chainId -> chain copy) }
    this.envelopes = []; // the synchronizer's view
  }

  addParty(id) {
    this.parties.set(id, { id, chains: new Map() });
  }

  copy(party, chainId) {
    const p = this.parties.get(party);
    return p ? p.chains.get(chainId) : undefined;
  }

  _sequence(recipients, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload)) + 96 * recipients.length;
    const env = {
      updateId: rid('upd-'),
      at: new Date().toISOString(),
      recipients: [...recipients],
      bytes,
      ciphertext: crypto.randomBytes(12).toString('hex'),
    };
    this.envelopes.push(env);
    if (this.envelopes.length > 300) this.envelopes.shift();
    return env;
  }

  createChain(chainId, submitter, members, genesisHead) {
    const env = this._sequence(members, { chainId, members });
    for (const m of members) {
      this.parties.get(m).chains.set(chainId, {
        chainId, submitter, members: [...members], genesisHead,
        lastSeq: 0, lastHead: genesisHead, anchors: [], createdUpdate: env.updateId,
      });
    }
  }

  append(chainId, submitter, a) {
    const own = this.copy(submitter, chainId);
    if (!own) throw new LedgerError(`${submitter} is not a member of chain ${chainId}`);
    if (own.submitter !== submitter) throw new LedgerError(`Only ${own.submitter} can append to chain ${chainId}`);
    // Each member's node checks continuity against its own copy before it signs.
    for (const m of own.members) {
      const c = this.copy(m, chainId);
      if (a.seq !== c.lastSeq + 1) throw new LedgerError(`${m} refused to sign: expected seq ${c.lastSeq + 1}, got ${a.seq}`);
      if (a.prevHead !== c.lastHead) throw new LedgerError(`${m} refused to sign: prev_head does not match its chain head`);
    }
    const env = this._sequence(own.members, a);
    const anchor = {
      contractId: rid('#00'),
      template: 'Sthiranet.Audit:AuditAnchor',
      chainId,
      ...a,
      signatories: [...own.members],
      updateId: env.updateId,
      recordedAt: env.at,
    };
    for (const m of own.members) {
      const c = this.copy(m, chainId);
      c.anchors.push(Object.freeze(clone(anchor)));
      c.lastSeq = a.seq;
      c.lastHead = a.head;
    }
    return clone(anchor);
  }

  // Adding a member needs every existing member's consent (auto-given in the demo).
  // The new member's node receives the chain's existing anchors, so it can verify history.
  addMember(chainId, newMember, submitter) {
    const src = this.copy(submitter, chainId);
    if (!src) throw new LedgerError(`Unknown chain ${chainId}`);
    if (src.members.includes(newMember)) return;
    const members = [...src.members, newMember];
    this._sequence(members, { chainId, addMember: newMember });
    for (const m of src.members) this.copy(m, chainId).members = [...members];
    const copy = clone(src);
    copy.members = members;
    copy.anchors = copy.anchors.map((x) => Object.freeze(x));
    this.parties.get(newMember).chains.set(chainId, copy);
  }

  // Rewriting history means archiving an anchor. It needs every signatory; only the actor signs.
  attemptArchive(chainId, actor, seq) {
    const c = this.copy(actor, chainId);
    if (!c) {
      return { ok: false, actor, chainId, seq, required: [], signed: [], missing: [],
        reason: `${actor}'s node holds no copy of chain ${chainId}: it is not a stakeholder, so it cannot even see these anchors.` };
    }
    const anchor = c.anchors.find((x) => x.seq === seq);
    if (!anchor) throw new LedgerError(`Chain ${chainId} has no anchor #${seq}`);
    const required = [...anchor.signatories];
    const signed = [actor];
    const missing = required.filter((p) => !signed.includes(p));
    this._sequence(required, { archive: anchor.contractId });
    return {
      ok: false, actor, chainId, seq, contractId: anchor.contractId, required, signed, missing,
      reason: `Archiving AuditAnchor #${seq} needs the signatures of ${required.join(', ')}. ` +
        `Only ${actor} signed; ${missing.join(' and ')} did not. The ledger rejected the transaction and the anchor is unchanged.`,
    };
  }

  view(party) {
    const p = this.parties.get(party);
    return p ? [...p.chains.values()].map(clone) : [];
  }
}

module.exports = { Ledger, LedgerError };
