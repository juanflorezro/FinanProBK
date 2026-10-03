import { currentOrgId } from '../context.js';

const QUERY_OPS = [
  'find', 'findOne', 'countDocuments', 'distinct',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
];

// Stages que deben ir primero en un pipeline; el $match de orgId se inserta después.
const FIRST_STAGES = ['$geoNear', '$search', '$searchMeta', '$vectorSearch'];

class TenantError extends Error {
  constructor(msg) { super(msg); this.status = 500; this.code = 'TENANT_CONTEXT_MISSING'; }
}

/**
 * Aísla cada colección por orgId.
 * - Toda consulta sin orgId en contexto falla, salvo .setOptions({ skipTenant: true })
 *   (solo para el panel de plataforma y jobs del sistema).
 * - Nunca permite cambiar orgId en un update.
 */
export function tenantPlugin(schema) {
  schema.add({ orgId: { type: 'ObjectId', ref: 'Organization', required: true, index: true, immutable: true } });

  schema.pre(QUERY_OPS, async function () {
    if (this.getOptions().skipTenant) return;
    const orgId = currentOrgId();
    if (!orgId) throw new TenantError(`Consulta ${this.op} en ${this.model.modelName} sin orgId`);
    this.where({ orgId });

    const update = this.getUpdate?.();
    if (update) {
      delete update.orgId;
      if (update.$set) delete update.$set.orgId;
    }
  });

  schema.pre('aggregate', async function () {
    if (this.options?.skipTenant) return;
    const orgId = currentOrgId();
    if (!orgId) throw new TenantError('Aggregate sin orgId');
    const pipeline = this.pipeline();
    const first = pipeline[0] && Object.keys(pipeline[0])[0];
    const idx = FIRST_STAGES.includes(first) ? 1 : 0;
    // También excluye lo eliminado (borrado lógico), salvo .option({ withDeleted: true })
    pipeline.splice(idx, 0, { $match: this.options?.withDeleted ? { orgId } : { orgId, deletedAt: null } });
  });

  // Va en 'validate' (no en 'save'): Mongoose valida ANTES de los hooks de save,
  // así que si asignamos orgId en save, la validación ya falló con "orgId is required".
  schema.pre('validate', async function () {
    const orgId = currentOrgId();
    if (this.isNew && !this.orgId) {
      if (!orgId) throw new TenantError(`Creando ${this.constructor.modelName} sin orgId`);
      this.orgId = orgId;
    }
  });

  schema.pre('save', async function () {
    const orgId = currentOrgId();
    if (orgId && this.orgId && !this.orgId.equals(orgId)) {
      throw new TenantError('El documento pertenece a otra organización');
    }
  });
  // Nota: insertMany y bulkWrite no pasan por estos hooks.
  // Úsalos solo pasando orgId explícito en cada documento.
}
export default tenantPlugin;
