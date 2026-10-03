import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';
import { ROLE_NAMES } from '../../config/permissions.js';

// Sin plugin de tenant: un usuario consulta sus membresías de varias orgs.
const membershipSchema = createSchema({
  orgId: ref('Organization', { required: true }),
  userId: ref('User', { required: true }),
  role: enumOf(ROLE_NAMES, { required: true }),
  status: enumOf(['activa', 'suspendida'], { default: 'activa' }),
  cashAccountIds: [ref('CashAccount')],
  routeId: ref('CollectionRoute'),
  invitedBy: ref('User'),
  joinedAt: { type: Date, default: Date.now },
}, { tenant: false });

membershipSchema.index({ orgId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });

export const Membership = mongoose.model('Membership', membershipSchema, 'memberships');
