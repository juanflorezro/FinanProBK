import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, ref, enumOf } from '../../db/types.js';

export const PAYMENT_METHODS = ['efectivo', 'transferencia', 'nequi', 'daviplata', 'pasarela', 'otro'];

const paymentSchema = createSchema({
  receiptNumber: { type: String, required: true },
  loanId: ref('Loan', { required: true }),
  borrowerId: ref('Borrower', { required: true }),
  cashAccountId: ref('CashAccount', { required: true }),
  receivedBy: ref('Membership'),

  amount: money({ required: true }), // negativo solo en reversos
  currency: { type: String, required: true, default: 'COP', uppercase: true },
  method: enumOf(PAYMENT_METHODS, { required: true }),
  channel: enumOf(['oficina', 'cobrador', 'portal'], { default: 'oficina' }),
  externalReference: String,
  idempotencyKey: { type: String, required: true },

  paidAt: { type: Date, required: true, default: Date.now },
  valueDate: { type: Date, required: true, default: Date.now }, // fecha para calcular intereses

  status: enumOf(['aplicado', 'reversado'], { default: 'aplicado' }),
  isReversal: { type: Boolean, default: false },
  reversalOfId: ref('Payment'),
  reversedById: ref('Payment'),
  reversalReason: String,

  // Resumen de la aplicación (detalle en PaymentAllocation)
  appliedLateInterest: money(),
  appliedFees: money(),
  appliedInterest: money(),
  appliedPrincipal: money(),
  unappliedAmount: money(), // saldo a favor

  triggeredReschedule: { type: Boolean, default: false }, // abono extraordinario o liquidación que cambió el plan
  applyTo: enumOf(['automatico', 'cuotas', 'intereses', 'capital', 'liquidacion'], { default: 'automatico' }),
  capitalEffect: enumOf(['reducir_cuota', 'reducir_plazo']),
  targetNumbers: [Number],
  components: [{ type: String, enum: ['mora', 'cargo', 'interes', 'capital'] }], // conceptos pagados en modo 'cuotas'
  notes: { type: String, maxlength: 300 },
  receiptPdfKey: String,
});

paymentSchema.index({ orgId: 1, receiptNumber: 1 }, { unique: true });
paymentSchema.index({ orgId: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ orgId: 1, loanId: 1, paidAt: -1 });
paymentSchema.index({ orgId: 1, cashAccountId: 1, paidAt: -1 });

paymentSchema.path('amount').validate(function (v) {
  return this.isReversal ? v < 0 : v > 0;
}, 'Un pago debe ser positivo y un reverso negativo');

// Inmutable: después de creado solo puede marcarse como reversado.
// Campos que no cambian saldos: soporte los puede corregir. Monto y aplicación nunca (para eso se reversa).
const EDITABLE_AFTER_CREATE = ['status', 'reversedById', 'reversalReason', 'receiptPdfKey', 'updatedBy', 'updatedAt', '__v', 'method', 'externalReference', 'cashAccountId'];
paymentSchema.pre('save', function () {
  if (this.isNew) return;
  const forbidden = this.modifiedPaths().filter((p) => !EDITABLE_AFTER_CREATE.includes(p));
  if (forbidden.length) {
    throw Object.assign(new Error(`Pago inmutable, no se puede cambiar: ${forbidden.join(', ')}`), { status: 409 });
  }
});

paymentSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw Object.assign(new Error('Los pagos no se borran; se reversan'), { status: 409 });
});

export const Payment = mongoose.model('Payment', paymentSchema, 'payments');
