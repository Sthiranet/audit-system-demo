// Typed client for demo-director. Types come from its OpenAPI spec (`npm run gen:api`),
// so a backend change breaks this build instead of the live demo.
import createClient from 'openapi-fetch';
import type { components, paths } from './schema';

export type S = components['schemas'];
export type StateView = S['StateView'];
export type SubView = S['SubView'];
export type MerkleTreeNode = S['MerkleTree'];
export type Anchor = S['Anchor'];
export type VerifyResponse = S['VerifyResponse'];
export type BatchCheck = S['BatchCheck'];
export type ArchiveAttempt = S['ArchiveAttempt'];
export type TrailHolder = S['TrailHolder'];

const client = createClient<paths>({ baseUrl: '' });

type Result<T> = { data?: T; error?: unknown; response: Response };

async function call<T>(p: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await p;
  if (error !== undefined || data === undefined) {
    const msg = (error as { error?: string } | undefined)?.error;
    throw new Error(msg || response.statusText || 'Request failed');
  }
  return data;
}

const path = <T extends Record<string, string | number>>(p: T) => ({ params: { path: p } });

export const api = {
  state: () => call(client.GET('/api/state')),
  pending: (id: string) => call(client.GET('/api/pending/{id}', path({ id }))),
  capture: (id: string, count: number) => call(client.POST('/api/capture/{id}', { ...path({ id }), body: { count } })),
  seal: (id: string) => call(client.POST('/api/seal/{id}', path({ id }))),
  batch: (id: string, seq: number) => call(client.GET('/api/batch/{id}/{seq}', path({ id, seq }))),
  ledger: (party: string) => call(client.GET('/api/ledger/{party}', path({ party }))),
  rewrite: (actor: string, chain: string, seq: number) =>
    call(client.POST('/api/ledger/rewrite', { body: { actor, chain, seq } })),
  trail: (where: TrailHolder, chain: string) => call(client.GET('/api/trail/{where}/{chain}', path({ where, chain }))),
  push: (id: string) => call(client.POST('/api/push/{id}', path({ id }))),
  tamper: (body: S['TamperRequest']) => call(client.POST('/api/tamper', { body })),
  verify: (verifier: string, chain: string) => call(client.POST('/api/verify', { body: { verifier, chain } })),
  addAuditor: () => call(client.POST('/api/auditor')),
  setAuto: (on: boolean) => call(client.POST('/api/auto', { body: { on } })),
  reset: () => call(client.POST('/api/reset')),
};

export const keys = {
  state: ['state'] as const,
  pending: (id: string) => ['pending', id] as const,
  batch: (id: string, seq: number) => ['batch', id, seq] as const,
  ledger: (party: string) => ['ledger', party] as const,
  trail: (where: TrailHolder, chain: string) => ['trail', where, chain] as const,
};
