import mongoose from 'mongoose';
import { ref, enumOf } from '../../db/types.js';

// Bitácora solo de inserción: no tiene rutas para editar ni borrar.
const auditLogSchema = new mongoose.Schema({
  orgId: { ...ref('Organization'), default: null },
  actorType: enumOf(['platform_admin', 'user', 'borrower', 'system'], { required: true }),
  actorId: { type: 'ObjectId' },
  actorEmail: String,
  supportGrantId: ref('SupportGrant'),
  action: { type: String, required: true },
  entity: String,
  entityId: { type: 'ObjectId' },
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  ip: String,
  userAgent: String,
  requestId: String,
  at: { type: Date, default: Date.now },
}, { versionKey: false });

auditLogSchema.index({ orgId: 1, at: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ actorType: 1, actorId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });

const block = () => { throw Object.assign(new Error('La bitácora no se modifica'), { status: 409 }); };
auditLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'], block);

export const AuditLog = mongoose.model('AuditLog', auditLogSchema, 'audit_logs');
