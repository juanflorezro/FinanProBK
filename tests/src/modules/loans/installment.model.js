import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, ref, enumOf } from '../../db/types.js';

export const INSTALLMENT_STATUS = ['pendiente', 'parcial', 'pagada', 'vencida', 'condonada', 'anulada'];

const installmentSchema = createSchema({
  loanId: ref('Loan', { required: true }),
  number: { type: Number, required: true, min: 1 },
  scheduleVersion: { type: Number, default: 1 }, // sube al cambiar tasa o reestructurar
  dueDate: { type: Date, required: true },

  openingBalance: money(),
  principalDue: money(),
  interestDue: money(),
  feesDue: money(),
  closingBalance: money(),

  principalPaid: money(),
  interestPaid: money(),
  feesPaid: money(),
  lateInterestAccrued: money(),
  lateInterestPaid: money(),
  waived: money(),
  lateAccruedUntil: Date, // hasta qué día ya se causó la mora

  status: enumOf(INSTALLMENT_STATUS, { default: 'pendiente' }),
  daysPastDue: { type: Number, default: 0 },
  paidAt: Date,
});

installmentSchema.index({ orgId: 1, loanId: 1, scheduleVersion: 1, number: 1 }, { unique: true });
installmentSchema.index({ orgId: 1, status: 1, dueDate: 1 }); // job diario de mora

installmentSchema.virtual('totalDue').get(function () {
  return this.principalDue + this.interestDue + this.feesDue + this.lateInterestAccrued;
});

installmentSchema.virtual('totalPaid').get(function () {
  return this.principalPaid + this.interestPaid + this.feesPaid + this.lateInterestPaid;
});

installmentSchema.virtual('pending').get(function () {
  return Math.max(0, this.totalDue - this.totalPaid - this.waived);
});

/** Recalcula estado según lo pagado y la fecha. */
installmentSchema.methods.refreshStatus = function (today = new Date()) {
  if (['condonada', 'anulada'].includes(this.status)) return this.status;
  if (this.pending === 0) {
    this.status = 'pagada';
    this.paidAt ??= today;
    this.daysPastDue = 0;
  } else {
    this.paidAt = undefined;
    const late = today > this.dueDate;
    this.daysPastDue = late ? Math.floor((today - this.dueDate) / 86_400_000) : 0;
    this.status = late ? 'vencida' : this.totalPaid > 0 ? 'parcial' : 'pendiente';
  }
  return this.status;
};

export const Installment = mongoose.model('Installment', installmentSchema, 'installments');
