import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, ref, enumOf } from '../../db/types.js';

export const COMPONENTS = ['mora', 'cargo', 'interes', 'capital', 'saldo_a_favor'];

// Cómo se repartió cada pago entre cuotas y componentes (cascada).
const allocationSchema = createSchema({
  paymentId: ref('Payment', { required: true }),
  loanId: ref('Loan', { required: true }),
  installmentId: ref('Installment'),
  chargeId: ref('Charge'),
  component: enumOf(COMPONENTS, { required: true }),
  amount: money({ required: true }),
  order: { type: Number, required: true },
}, { optimisticConcurrency: false });

allocationSchema.index({ orgId: 1, paymentId: 1, order: 1 });
allocationSchema.index({ orgId: 1, installmentId: 1 });

allocationSchema.pre('save', function () {
  if (!this.isNew) throw Object.assign(new Error('Las aplicaciones de pago son inmutables'), { status: 409 });
});

export const PaymentAllocation = mongoose.model('PaymentAllocation', allocationSchema, 'payment_allocations');
