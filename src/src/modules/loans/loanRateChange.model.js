import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { rate, ref, enumOf } from '../../db/types.js';
import { RATE_BASES, deriveRates } from '../../utils/rates.js';

// Historial de tasas de un préstamo. La fila sequence = 1 es la tasa pactada al inicio.
const loanRateChangeSchema = createSchema({
  loanId: ref('Loan', { required: true }),
  sequence: { type: Number, required: true, min: 1 },
  rate: rate({ required: true }),
  rateBasis: enumOf(RATE_BASES, { required: true }),
  rateKind: enumOf(['nominal', 'efectiva'], { default: 'efectiva' }),
  lateRate: rate({ default: '0' }),
  frequency: { type: String, required: true }, // copia de la frecuencia del préstamo
  rateMonthly: rate(),
  rateAnnual: rate(),
  effectiveFrom: { type: Date, required: true },
  fromInstallmentNumber: { type: Number, min: 1 },
  reason: enumOf(['pactada', 'negociacion', 'reestructura', 'beneficio', 'otro'], { default: 'pactada' }),
  notes: String,
  approvedBy: ref('Membership'),
  approvedAt: Date,
  documentId: ref('Document'), // otrosí o acuerdo firmado
}, { optimisticConcurrency: false });

loanRateChangeSchema.index({ orgId: 1, loanId: 1, sequence: 1 }, { unique: true });
loanRateChangeSchema.index({ orgId: 1, loanId: 1, effectiveFrom: -1 });

loanRateChangeSchema.pre('validate', function () {
  if (this.rate == null) return;
  const { rateMonthly, rateAnnual } = deriveRates(this);
  this.rateMonthly = rateMonthly;
  this.rateAnnual = rateAnnual;
});

// Un cambio de tasa es histórico: no se edita, se crea otro.
loanRateChangeSchema.pre('save', function () {
  if (!this.isNew) throw Object.assign(new Error('Un cambio de tasa no se edita; registra uno nuevo'), { status: 409 });
});

export const LoanRateChange = mongoose.model('LoanRateChange', loanRateChangeSchema, 'loan_rate_changes');
