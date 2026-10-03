import { AuditLog } from './auditLog.model.js';

const plain = (doc) => (doc?.toObject ? doc.toObject({ depopulate: true }) : doc);

/** Registra una acción. Nunca rompe la petición si falla la escritura de la bitácora. */
export async function audit(req, { action, entity, entityId, orgId = null, before, after, supportGrantId }) {
  try {
    const admin = req?.admin;
    await AuditLog.create({
      orgId,
      actorType: admin ? 'platform_admin' : req?.user ? 'user' : 'system',
      actorId: admin?._id ?? req?.user?._id,
      actorEmail: admin?.email ?? req?.user?.email,
      supportGrantId,
      action,
      entity,
      entityId,
      before: plain(before),
      after: plain(after),
      ip: req?.ip,
      userAgent: req?.get?.('user-agent'),
      requestId: req?.id,
    });
  } catch (err) {
    req?.log?.error({ err }, 'No se pudo escribir la bitácora');
  }
}
