import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

export const SUBSCRIPTION_STATUS = ['prueba', 'activa', 'en_gracia', 'vencida', 'cancelada'];

// Una suscripción por cliente. orgId se llena cuando el dueño crea su organización.
const subscriptionSchema = createSchema({
  tenantAccountId: ref('TenantAccount', { required: true }),
  orgId: { ...ref('Organization'), default: null },
  planId: ref('Plan', { required: true }),
  status: enumOf(SUBSCRIPTION_STATUS, { default: 'prueba' }),
  currentPeriodStart: { type: Date, required: true },
  currentPeriodEnd: { type: Date, required: true },
  graceUntil: Date,
  autoRenew: { type: Boolean, default: false },
  limitsSnapshot: {
    maxUsers: { type: Number, default: 0 },
    maxBorrowers: { type: Number, default: 0 },
    maxActiveLoans: { type: Number, default: 0 },
  },
  cancelledAt: Date,
  notes: String,
}, { tenant: false });

subscriptionSchema.index({ tenantAccountId: 1 }, { unique: true });
subscriptionSchema.index({ orgId: 1 });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export const Subscription = mongoose.model('Subscription', subscriptionSchema, 'subscriptions');
