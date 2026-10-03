import { z } from 'zod';
import mongoose from 'mongoose';
import { objectId } from './schemas.js';
import { LOAN_STATUS, AMORTIZATION } from '../modules/loans/loan.model.js';
import { Borrower } from '../modules/borrowers/borrower.model.js';
import { PAYMENT_METHODS } from '../modules/payments/payment.model.js';

// Filtros compartidos por los listados y las exportaciones a Excel (así el Excel trae lo mismo que ves).

export const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const day = (d, end) => { const x = new Date(d); if (end) x.setUTCHours(23, 59, 59, 999); return x; };
const range = (from, to) => (from || to ? { ...(from && { $gte: day(from) }), ...(to && { $lte: day(to, true) }) } : undefined);
const money = z.coerce.number().int().min(0); // centavos
// Los ids llegan como texto; en aggregate Mongo no los convierte solo
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const ID_FIELDS = ['borrowerId', 'collectorId', 'loanId', 'cashAccountId'];

/** IDs de deudores que coinciden con un texto (nombre, documento, código o celular). */
async function borrowerIdsMatching(q) {
  const rx = new RegExp(escapeRx(q), 'i');
  const words = q.split(/\s+/).filter(Boolean).map((w) => new RegExp(escapeRx(w), 'i'));
  const rows = await Borrower.find({
    $or: [
      { docNumber: rx }, { code: rx }, { phone: rx },
      ...(words.length > 1 ? [{ $and: words.map((w) => ({ $or: [{ firstName: w }, { lastName: w }] })) }] : [{ firstName: rx }, { lastName: rx }]),
    ],
  }).select('_id').limit(500).lean();
  return rows.map((r) => r._id);
}

// ---------------------------------------------------------------- Deudores
export const borrowerQuery = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.enum(['activo', 'inactivo', 'bloqueado']).optional(),
  riskRating: z.enum(['A', 'B', 'C', 'D']).optional(),
  city: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['nombre', 'recientes', 'antiguos']).default('nombre'),
});

export async function buildBorrowerFilter(f) {
  const filter = {};
  if (f.status) filter.status = f.status;
  if (f.riskRating) filter.riskRating = f.riskRating;
  if (f.city) filter.city = new RegExp(escapeRx(f.city), 'i');
  if (range(f.from, f.to)) filter.createdAt = range(f.from, f.to);
  if (f.q) filter._id = { $in: await borrowerIdsMatching(f.q) };
  const sort = { nombre: { lastName: 1, firstName: 1 }, recientes: { createdAt: -1 }, antiguos: { createdAt: 1 } }[f.sort];
  return { filter, sort };
}

// ---------------------------------------------------------------- Préstamos
export const loanQuery = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.enum(LOAN_STATUS).optional(),
  borrowerId: objectId.optional(),
  collectorId: objectId.optional(),
  overdue: z.enum(['true', 'false']).optional(),
  minDpd: z.coerce.number().int().min(0).optional(),
  lendingRegime: z.enum(['formal', 'informal']).optional(),
  amortization: z.enum(AMORTIZATION).optional(),
  frequency: z.enum(['diaria', 'semanal', 'quincenal', 'mensual']).optional(),
  minPrincipal: money.optional(),
  maxPrincipal: money.optional(),
  from: z.coerce.date().optional(), // fecha de desembolso
  to: z.coerce.date().optional(),
  dueFrom: z.coerce.date().optional(), // próxima cuota
  dueTo: z.coerce.date().optional(),
  sort: z.enum(['recientes', 'antiguos', 'mora', 'saldo', 'proxima']).default('recientes'),
});

export async function buildLoanFilter(f) {
  const filter = {};
  for (const k of ['status', 'borrowerId', 'collectorId', 'lendingRegime', 'amortization', 'frequency']) if (f[k]) filter[k] = ID_FIELDS.includes(k) ? oid(f[k]) : f[k];
  if (f.overdue === 'true') filter.daysPastDue = { $gt: 0 };
  if (f.minDpd) filter.daysPastDue = { $gte: f.minDpd };
  if (f.minPrincipal != null || f.maxPrincipal != null) {
    filter.principal = { ...(f.minPrincipal != null && { $gte: f.minPrincipal }), ...(f.maxPrincipal != null && { $lte: f.maxPrincipal }) };
  }
  if (range(f.from, f.to)) filter.disbursementDate = range(f.from, f.to);
  if (range(f.dueFrom, f.dueTo)) filter.nextDueDate = range(f.dueFrom, f.dueTo);
  if (f.q) {
    const ids = await borrowerIdsMatching(f.q);
    filter.$or = [{ loanNumber: new RegExp(escapeRx(f.q), 'i') }, { borrowerId: { $in: ids } }];
  }
  const sort = {
    recientes: { createdAt: -1 }, antiguos: { createdAt: 1 }, mora: { daysPastDue: -1, createdAt: -1 },
    saldo: { balancePrincipal: -1 }, proxima: { nextDueDate: 1 },
  }[f.sort];
  return { filter, sort };
}

// ---------------------------------------------------------------- Pagos
export const paymentQuery = z.object({
  q: z.string().trim().max(60).optional(),
  loanId: objectId.optional(),
  borrowerId: objectId.optional(),
  cashAccountId: objectId.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  channel: z.enum(['oficina', 'cobrador', 'portal']).optional(),
  kind: z.enum(['aplicados', 'reversados', 'reversos']).optional(),
  minAmount: money.optional(),
  maxAmount: money.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['recientes', 'antiguos', 'mayor', 'menor']).default('recientes'),
});

export async function buildPaymentFilter(f) {
  const filter = {};
  for (const k of ['loanId', 'borrowerId', 'cashAccountId', 'method', 'channel']) if (f[k]) filter[k] = ID_FIELDS.includes(k) ? oid(f[k]) : f[k];
  if (f.kind === 'aplicados') Object.assign(filter, { status: 'aplicado', isReversal: false });
  if (f.kind === 'reversados') filter.status = 'reversado';
  if (f.kind === 'reversos') filter.isReversal = true;
  if (f.minAmount != null || f.maxAmount != null) {
    filter.amount = { ...(f.minAmount != null && { $gte: f.minAmount }), ...(f.maxAmount != null && { $lte: f.maxAmount }) };
  }
  if (range(f.from, f.to)) filter.paidAt = range(f.from, f.to);
  if (f.q) {
    const ids = await borrowerIdsMatching(f.q);
    filter.$or = [{ receiptNumber: new RegExp(escapeRx(f.q), 'i') }, { externalReference: new RegExp(escapeRx(f.q), 'i') }, { borrowerId: { $in: ids } }];
  }
  const sort = { recientes: { paidAt: -1 }, antiguos: { paidAt: 1 }, mayor: { amount: -1 }, menor: { amount: 1 } }[f.sort];
  return { filter, sort };
}
