import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

// Contexto por request: qué organización y qué usuario están operando.
const als = new AsyncLocalStorage();

export function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

export function getContext() {
  return als.getStore() ?? {};
}

export function currentOrgId() {
  const { orgId } = getContext();
  return orgId ? new mongoose.Types.ObjectId(String(orgId)) : null;
}
