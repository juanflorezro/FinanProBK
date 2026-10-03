import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, ref, enumOf } from '../../db/types.js';

// Lo que tus clientes te pagan por usar la plataforma.
const subscriptionPaymentSchema = createSchema({
  subscriptionId: ref('Subscription', { required: true }),
  tenantAccountId: ref('TenantAccount', { required: true }),
  planId: ref('Plan'),
  amount: money({ required: true, min: 0 }),
  currency: { type: String, default: 'COP', uppercase: true },
  method: enumOf(['transferencia', 'pasarela', 'efectivo', 'nequi', 'daviplata', 'otro'], { default: 'transferencia' }),
  reference: { type: String, trim: true },
  periods: { type: Number, default: 1, min: 1 },
  periodFrom: { type: Date, required: true },
  periodTo: { type: Date, required: true },
  paidAt: { type: Date, default: Date.now },
  status: enumOf(['confirmado', 'anulado'], { default: 'confirmado' }),
  registeredBy: ref('PlatformAdmin'),
  notes: String,
}, { tenant: false });

subscriptionPaymentSchema.index({ tenantAccountId: 1, paidAt: -1 });
subscriptionPaymentSchema.index({ reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } });
subscriptionPaymentSchema.index({ paidAt: -1 });

export const SubscriptionPayment = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema, 'subscription_payments');
