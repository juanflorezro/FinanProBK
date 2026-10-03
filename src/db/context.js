import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

// Contexto por request: qué organización y qué usuario están operando.
const als = new AsyncLocalStorage();

/**
 * Ejecuta fn dentro del contexto de una organización.
 * OJO: si fn devuelve una consulta de Mongoose, ejecútala adentro con .exec() o await;
 * una consulta que se ejecuta después ya no tiene el contexto.
 */
export function runWithContext(ctx, fn) {
  return als.run(ctx, () => {
    const out = fn();
    // Si devuelve una Query sin ejecutar, se ejecuta aquí para que conserve el contexto
    return out && typeof out.exec === 'function' && typeof out.getFilter === 'function' ? out.exec() : out;
  });
}

export function getContext() {
  return als.getStore() ?? {};
}

export function currentOrgId() {
  const { orgId } = getContext();
  return orgId ? new mongoose.Types.ObjectId(String(orgId)) : null;
}
