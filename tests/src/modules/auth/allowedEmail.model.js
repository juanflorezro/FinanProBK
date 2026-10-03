import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';
import { ROLE_NAMES } from '../../config/permissions.js';

// La puerta de acceso: sin una fila aquí (o una membresía activa) nadie entra.
const allowedEmailSchema = createSchema({
  email: { type: String, required: true, lowercase: true, trim: true },
  tenantAccountId: ref('TenantAccount'),
  orgId: { ...ref('Organization'), default: null }, // null = invitación de dueño para crear su org
  intendedRole: enumOf(ROLE_NAMES, { default: 'owner' }),
  invitedByType: enumOf(['platform_admin', 'user'], { default: 'platform_admin' }),
  invitedById: { type: 'ObjectId' },
  status: enumOf(['habilitado', 'usado', 'revocado', 'expirado'], { default: 'habilitado' }),
  expiresAt: { type: Date, default: null },
  usedAt: Date,
  usedByUserId: ref('User'),
}, { tenant: false });

allowedEmailSchema.index({ email: 1, orgId: 1 }, { unique: true });

allowedEmailSchema.statics.validFilter = (email, extra = {}) => ({
  email: email.toLowerCase(),
  status: 'habilitado',
  $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  ...extra,
});

export const AllowedEmail = mongoose.model('AllowedEmail', allowedEmailSchema, 'allowed_emails');
