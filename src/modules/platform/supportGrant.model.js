import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

// Permiso temporal para que un admin vea (o corrija) datos de una organización.
const supportGrantSchema = createSchema({
  orgId: ref('Organization', { required: true }),
  adminId: ref('PlatformAdmin', { required: true }),
  scope: enumOf(['lectura', 'escritura'], { default: 'lectura' }),
  reason: { type: String, required: true },
  ticketRef: String,
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
}, { tenant: false, optimisticConcurrency: false });

supportGrantSchema.index({ orgId: 1, adminId: 1, expiresAt: -1 });

supportGrantSchema.statics.activeFor = function (orgId, adminId) {
  return this.findOne({ orgId, adminId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ expiresAt: -1 });
};

export const SupportGrant = mongoose.model('SupportGrant', supportGrantSchema, 'support_grants');
