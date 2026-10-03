import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, rate, ref, enumOf } from '../../db/types.js';
import { RATE_BASES, FREQUENCIES, deriveRates } from '../../utils/rates.js';

export const LOAN_STATUS = [
  'solicitud', 'aprobado', 'desembolsado', 'al_dia', 'en_mora',
  'reestructurado', 'pagado', 'castigado', 'anulado',
];
export const AMORTIZATION = ['frances', 'aleman', 'interes_simple', 'solo_interes', 'abonos_libres'];
export const OPEN_STATUS = ['desembolsado', 'al_dia', 'en_mora'];

const loanSchema = createSchema({
  loanNumber: { type: String, required: true },
  borrowerId: ref('Borrower', { required: true }),
  productId: ref('LoanProduct'),
  officerId: ref('Membership'),
  collectorId: ref('Membership'),
  restructuredFromId: ref('Loan'),
  lendingRegime: enumOf(['formal', 'informal'], { default: 'formal' }),

  // Capital
  principal: money({ required: true, min: 1 }),
  currency: { type: String, required: true, default: 'COP', uppercase: true },

  // Tasa libre por préstamo
  rate: rate({ required: true }),                       // ej. "20" = 20 %
  rateBasis: enumOf(RATE_BASES, { required: true, default: 'mensual' }),
  rateKind: enumOf(['nominal', 'efectiva'], { default: 'efectiva' }),
  interestBase: enumOf(['saldo_capital', 'capital_inicial'], { default: 'saldo_capital' }),
  rateSource: enumOf(['producto', 'manual'], { default: 'manual' }),
  lateRate: rate({ default: '0' }),
  lateRateBasis: enumOf(RATE_BASES, { default: 'mensual' }),
  lateInterestBase: enumOf(['capital', 'capital_e_interes'], { default: 'capital' }), // sobre qué se cobra la mora
  // Calculadas en pre('validate'), solo informativas / para el plan de cuotas
  ratePerPeriod: rate(),
  rateMonthly: rate(),
  rateAnnual: rate(),
  currentRateChangeId: ref('LoanRateChange'),
  // Cumplimiento del tope legal (solo si la organización está acogida a la ley)
  rateCapCheck: enumOf(['no_aplica', 'dentro', 'excede_confirmado', 'sin_tope_cargado'], { default: 'no_aplica' }),
  rateCapId: ref('RateCap'),
  rateCapEA: rate(),
  rateCapAckBy: ref('Membership'),
  rateCapAckAt: Date,

  // Plan
  amortization: enumOf(AMORTIZATION, { required: true, default: 'frances' }),
  frequency: enumOf(FREQUENCIES, { required: true, default: 'mensual' }),
  termCount: { type: Number, min: 1, required() { return this.amortization !== 'abonos_libres'; } },
  graceDays: { type: Number, default: 0, min: 0 },
  scheduleVersion: { type: Number, default: 1 }, // sube al regenerar el plan

  // Fechas
  applicationDate: { type: Date, default: Date.now },
  approvalDate: Date,
  disbursementDate: Date,
  firstDueDate: Date,
  maturityDate: Date,
  closedAt: Date,

  status: enumOf(LOAN_STATUS, { default: 'solicitud', index: true }),

  // Resumen desnormalizado (se recalcula desde Installment en cada transacción)
  balancePrincipal: money(),
  balanceInterest: money(),
  balanceLateInterest: money(),
  balanceFees: money(),
  totalPaid: money(),
  daysPastDue: { type: Number, default: 0 },
  agingBucket: enumOf(['0', '1-30', '31-60', '61-90', '90+'], { default: '0' }),
  nextDueDate: Date,
  nextDueAmount: money(),
  lastPaymentAt: Date,

  notes: String,
  // Eliminado por soporte: el cliente ya no lo ve, el administrador sí (historial)
  deletedReason: String,
  deletedByAdminId: ref('PlatformAdmin'),
  deletedTicketId: ref('Ticket'),
});

loanSchema.index({ orgId: 1, loanNumber: 1 }, { unique: true });
loanSchema.index({ orgId: 1, borrowerId: 1, status: 1 });
loanSchema.index({ orgId: 1, status: 1, nextDueDate: 1 });
loanSchema.index({ orgId: 1, collectorId: 1, daysPastDue: -1 });

loanSchema.pre('validate', function () {
  if (this.isModified('rate') || this.isModified('rateBasis') || this.isModified('rateKind') || this.isModified('frequency') || this.isNew) {
    if (this.rate == null) return;
    Object.assign(this, deriveRates({
      rate: this.rate, rateBasis: this.rateBasis, rateKind: this.rateKind, frequency: this.frequency,
    }));
  }
  if (this.isNew && this.balancePrincipal === 0) this.balancePrincipal = this.principal;
});

loanSchema.virtual('balanceTotal').get(function () {
  return this.balancePrincipal + this.balanceInterest + this.balanceLateInterest + this.balanceFees;
});

loanSchema.virtual('isOpen').get(function () {
  return OPEN_STATUS.includes(this.status);
});

export const Loan = mongoose.model('Loan', loanSchema, 'loans');
