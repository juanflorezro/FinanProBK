import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, ref, enumOf } from '../../db/types.js';

/**
 * Movimientos de caja distintos a los pagos de préstamos (los pagos ya son ingresos de su caja).
 * amount siempre positivo; el signo lo da el tipo. Inmutables: se anulan con motivo, no se borran.
 */
export const MOVEMENT_TYPES = {
  ingreso: 1,            // aporte de capital, otros ingresos
  egreso: -1,            // gastos, retiros
  desembolso: -1,        // entrega del dinero de un préstamo
  traslado_salida: -1,   // pasa dinero a otra caja
  traslado_entrada: 1,   // recibe dinero de otra caja
  ajuste_arqueo: 0,      // sobrante (+) o faltante (-) del arqueo; usa signedAmount
};

const movementSchema = createSchema({
  cashAccountId: ref('CashAccount', { required: true }),
  type: enumOf(Object.keys(MOVEMENT_TYPES), { required: true }),
  amount: money({ required: true }),
  signedAmount: money({ required: true }),       // con signo: lo que suma o resta al saldo
  date: { type: Date, required: true, default: Date.now },
  concept: { type: String, required: true, trim: true, maxlength: 200 },
  category: { type: String, trim: true, maxlength: 60 }, // ej. arriendo, nómina, papelería
  reference: { type: String, trim: true, maxlength: 80 },
  loanId: ref('Loan'),
  transferId: { type: String },                  // une las dos patas de un traslado
  counterpartCashAccountId: ref('CashAccount'),
  closingId: ref('CashClosing'),
  createdByMembershipId: ref('Membership'),
  voidedAt: Date,
  voidReason: String,
});
movementSchema.index({ orgId: 1, cashAccountId: 1, date: -1 });
movementSchema.pre('save', function () {
  if (this.isNew) return;
  const allowed = ['voidedAt', 'voidReason', 'updatedBy', 'updatedAt', '__v'];
  const bad = this.modifiedPaths().filter((p) => !allowed.includes(p));
  if (bad.length) throw Object.assign(new Error('Los movimientos de caja no se editan; se anulan'), { status: 409 });
});
export const CashMovement = mongoose.model('CashMovement', movementSchema, 'cash_movements');

/** Arqueo y cierre de una caja en una fecha. Después del cierre no se registra nada con fecha anterior. */
const closingSchema = createSchema({
  cashAccountId: ref('CashAccount', { required: true }),
  date: { type: Date, required: true },          // día cerrado (inicio del día UTC)
  periodFrom: Date,                              // desde el cierre anterior
  openingBalance: money(),
  payments: money(),                             // pagos netos (incluye reversos)
  inflows: money(),                              // otros ingresos y traslados recibidos
  outflows: money(),                             // egresos, desembolsos y traslados enviados (positivo)
  expectedBalance: money(),
  countedBalance: money(),
  difference: money(),                           // contado - esperado
  byMethod: { type: Map, of: Number },
  paymentsCount: Number,
  notes: { type: String, maxlength: 500 },
  closedByMembershipId: ref('Membership'),
});
closingSchema.index({ orgId: 1, cashAccountId: 1, date: -1 }, { unique: true });
export const CashClosing = mongoose.model('CashClosing', closingSchema, 'cash_closings');
