import mongoose from 'mongoose';
import basePlugin from './plugins/base.js';
import tenantPlugin from './plugins/tenant.js';

const toJSON = {
  getters: true,
  virtuals: false,
  transform(_doc, ret) {
    delete ret.__v;
    return ret;
  },
};

/**
 * Úsalo en vez de new mongoose.Schema para que todo modelo
 * tenga timestamps, auditoría, borrado lógico y (por defecto) orgId.
 * Colecciones globales de plataforma: createSchema(def, { tenant: false })
 */
export function createSchema(definition, { tenant = true, ...options } = {}) {
  const schema = new mongoose.Schema(definition, {
    timestamps: true,
    optimisticConcurrency: true, // bloqueo optimista con __v
    toJSON,
    toObject: toJSON,
    ...options,
  });
  schema.plugin(basePlugin);
  if (tenant) schema.plugin(tenantPlugin);
  return schema;
}
