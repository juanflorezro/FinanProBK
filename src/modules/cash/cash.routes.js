import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { httpError } from '../../utils/errors.js';
import { objectId, cents } from '../../utils/schemas.js';
import { Payment } from '../payments/payment.model.js';
import { CashAccount } from './cashAccount.model.js';
import { CashMovement, CashClosing } from './cash.models.js';
import { assertCashOpen, cashBalance, cashTotals, cashHasActivity, closeCash, dayStart, dayEnd } from './cash.service.js';
import { withTransaction } from '../../db/withTransaction.js';

// Cajas: saldo, libro de caja, movimientos, traslados, arqueo y cierre.
const router = Router();
const idParam = { params: z.object({ id: objectId }) };
const TYPES = ['efectivo', 'banco', 'billetera_digital'];

async function loadCash(id) {
  const c = await CashAccount.findById(id);
  if (!c) throw httpError(404, 'CASH_ACCOUNT_NOT_FOUND', 'Caja no encontrada');
  return c;
}

/** Lista de cajas con su saldo. ?todas=1 incluye inactivas. */
router.get('/', can('cash.read'), async (req, res) => {
  const filter = req.query.todas === '1' ? {} : { isActive: true };
  const list = await CashAccount.find(filter).sort({ isActive: -1, name: 1 });
  const withBalance = req.query.saldos === '1';
  const lastClosings = withBalance ? await CashClosing.aggregate([{ $sort: { date: -1 } }, { $group: { _id: '$cashAccountId', date: { $first: '$date' } } }]) : [];
  const closedMap = new Map(lastClosings.map((c) => [String(c._id), c.date]));
  res.json(await Promise.all(list.map(async (c) => (withBalance
    ? { ...c.toJSON(), balance: await cashBalance(c), lastClosingDate: closedMap.get(String(c._id)) ?? null }
    : c))));
});

router.post('/', can('cash.create'), validate({
  body: z.object({
    name: z.string().trim().min(2).max(60),
    type: z.enum(TYPES).default('efectivo'),
    bankName: z.string().trim().max(60).optional(),
    accountMask: z.string().regex(/^\d{4}$/).optional(),
    custodianMembershipId: objectId.optional(),
    openingBalance: cents.or(z.literal(0)).default(0),
    notes: z.string().trim().max(300).optional(),
  }),
}), async (req, res) => {
  res.status(201).json(await CashAccount.create({ ...req.valid.body, openingDate: new Date(), currency: req.org.currency }));
});

/** Editar datos de la caja. El saldo inicial solo se puede cambiar si la caja no tiene movimientos. */
router.patch('/:id', can('cash.update'), validate({
  ...idParam,
  body: z.object({
    name: z.string().trim().min(2).max(60).optional(),
    type: z.enum(TYPES).optional(),
    bankName: z.string().trim().max(60).or(z.literal('')).optional(),
    accountMask: z.string().regex(/^\d{4}$/).or(z.literal('')).optional(),
    custodianMembershipId: objectId.nullable().optional(),
    openingBalance: cents.or(z.literal(0)).optional(),
    notes: z.string().trim().max(300).or(z.literal('')).optional(),
    isActive: z.boolean().optional(),
  }),
}), async (req, res) => {
  const cash = await loadCash(req.valid.params.id);
  const body = req.valid.body;
  if (body.openingBalance !== undefined && body.openingBalance !== cash.openingBalance) {
    const act = await cashHasActivity(cash._id);
    if (act.payments || act.movements) throw httpError(409, 'CASH_HAS_ACTIVITY', 'El saldo inicial no se puede cambiar porque la caja ya tiene movimientos. Usa un ingreso o egreso de ajuste.');
  }
  if (body.isActive === false) {
    const balance = await cashBalance(cash);
    if (balance !== 0) throw httpError(409, 'CASH_HAS_BALANCE', `La caja tiene saldo (${balance / 100}). Trasládalo a otra caja antes de desactivarla.`);
  }
  cash.set(body);
  await cash.save();
  res.json(cash);
});

/** Eliminar: solo si nunca tuvo pagos ni movimientos. Si tuvo, se desactiva (queda el historial). */
router.delete('/:id', can('cash.delete'), validate(idParam), async (req, res) => {
  const cash = await loadCash(req.valid.params.id);
  const act = await cashHasActivity(cash._id);
  if (act.payments || act.movements) {
    const n = await Payment.countDocuments({ cashAccountId: cash._id });
    throw httpError(409, 'CASH_HAS_ACTIVITY', `No se puede eliminar: la caja tiene ${n} pagos o movimientos asociados. Puedes desactivarla para que no se use más; el historial se conserva.`);
  }
  cash.deletedAt = new Date();
  cash.isActive = false;
  cash.name = `${cash.name} (eliminada ${Date.now()})`; // libera el nombre
  await cash.save();
  res.status(204).end();
});

/** Saldo y resumen de un periodo. */
router.get('/:id/summary', can('cash.read'), validate({ ...idParam, query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }), async (req, res) => {
  const cash = await loadCash(req.valid.params.id);
  const { from, to } = req.valid.query;
  const opening = from ? await cashBalance(cash, new Date(dayStart(from).getTime() - 1)) : (cash.openingBalance ?? 0);
  const t = await cashTotals(cash._id, { from: from && dayStart(from), to: to && dayEnd(to) });
  const lastClosing = await CashClosing.findOne({ cashAccountId: cash._id }).sort({ date: -1 });
  res.json({
    cash, opening, ...t, closing: opening + t.payments + t.inflows - t.outflows,
    balance: await cashBalance(cash), lastClosing,
  });
});

/** Libro de caja: pagos y movimientos con saldo corrido. */
router.get('/:id/ledger', can('cash.read'), validate({ ...idParam, query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(1000).default(300) }) }), async (req, res) => {
  const cash = await loadCash(req.valid.params.id);
  const from = req.valid.query.from ? dayStart(req.valid.query.from) : null;
  const to = dayEnd(req.valid.query.to ?? new Date());
  const range = (f) => ({ [f]: { ...(from && { $gte: from }), $lte: to } });
  const [payments, movements] = await Promise.all([
    Payment.find({ cashAccountId: cash._id, ...range('paidAt') }).populate('loanId', 'loanNumber').populate('borrowerId', 'firstName lastName').lean(),
    CashMovement.find({ cashAccountId: cash._id, ...range('date') }).populate('loanId', 'loanNumber').lean(),
  ]);
  const rows = [
    ...payments.map((p) => ({
      kind: 'pago', id: p._id, date: p.paidAt, amount: p.amount, concept: `${p.isReversal ? 'Reverso de pago' : 'Pago'} ${p.loanId?.loanNumber ?? ''} ${p.borrowerId ? `${p.borrowerId.firstName} ${p.borrowerId.lastName}` : ''}`.trim(),
      reference: `Recibo ${p.receiptNumber}`, method: p.method, status: p.status,
    })),
    ...movements.map((m) => ({
      kind: m.type, id: m._id, date: m.date, amount: m.voidedAt ? 0 : m.signedAmount, concept: m.concept, reference: m.reference ?? (m.loanId ? m.loanId.loanNumber : ''),
      category: m.category, voided: Boolean(m.voidedAt), voidReason: m.voidReason,
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));
  let running = from ? await cashBalance(cash, new Date(from.getTime() - 1)) : (cash.openingBalance ?? 0);
  const opening = running;
  for (const r of rows) { running += r.amount; r.balance = running; }
  res.json({ opening, closing: running, rows: rows.slice(-req.valid.query.limit).reverse() });
});

/** Ingreso o egreso manual (aporte, gasto, retiro…). */
router.post('/:id/movements', can('cash.create'), validate({
  ...idParam,
  body: z.object({
    type: z.enum(['ingreso', 'egreso']),
    amount: cents,
    date: z.coerce.date().optional(),
    concept: z.string().trim().min(3).max(200),
    category: z.string().trim().max(60).optional(),
    reference: z.string().trim().max(80).optional(),
  }),
}), async (req, res) => {
  const cash = await loadCash(req.valid.params.id);
  if (!cash.isActive) throw httpError(409, 'CASH_INACTIVE', 'La caja está inactiva');
  const b = req.valid.body;
  const date = b.date ?? new Date();
  await assertCashOpen(cash._id, date);
  if (b.type === 'egreso') {
    const balance = await cashBalance(cash);
    if (cash.type === 'efectivo' && b.amount > balance) throw httpError(409, 'INSUFFICIENT_CASH', `No hay suficiente efectivo en la caja (saldo ${balance / 100}).`);
  }
  const m = await CashMovement.create({ ...b, date, cashAccountId: cash._id, signedAmount: b.type === 'ingreso' ? b.amount : -b.amount, createdByMembershipId: req.membership._id });
  res.status(201).json(m);
});

/** Anular un movimiento manual (no los pagos: esos se reversan). */
router.post('/:id/movements/:movementId/void', can('cash.update'), validate({
  params: z.object({ id: objectId, movementId: objectId }),
  body: z.object({ reason: z.string().trim().min(5).max(200) }),
}), async (req, res) => {
  const m = await CashMovement.findOne({ _id: req.valid.params.movementId, cashAccountId: req.valid.params.id });
  if (!m) throw httpError(404, 'MOVEMENT_NOT_FOUND', 'Movimiento no encontrado');
  if (m.voidedAt) throw httpError(409, 'ALREADY_VOIDED', 'El movimiento ya está anulado');
  if (['desembolso', 'ajuste_arqueo'].includes(m.type)) throw httpError(409, 'NOT_VOIDABLE', 'Este movimiento no se anula manualmente');
  await assertCashOpen(m.cashAccountId, m.date);
  const legs = m.transferId ? await CashMovement.find({ transferId: m.transferId }) : [m];
  for (const leg of legs) { leg.voidedAt = new Date(); leg.voidReason = req.valid.body.reason; await leg.save(); }
  res.json({ voided: legs.length });
});

/** Traslado entre cajas (dos movimientos enlazados). */
router.post('/:id/transfer', can('cash.create'), validate({
  ...idParam,
  body: z.object({ toCashAccountId: objectId, amount: cents, date: z.coerce.date().optional(), concept: z.string().trim().max(200).optional() }),
}), async (req, res) => {
  const from = await loadCash(req.valid.params.id);
  const to = await loadCash(req.valid.body.toCashAccountId);
  if (String(from._id) === String(to._id)) throw httpError(400, 'SAME_CASH', 'Elige una caja distinta');
  if (!from.isActive || !to.isActive) throw httpError(409, 'CASH_INACTIVE', 'Las dos cajas deben estar activas');
  const { amount } = req.valid.body;
  const date = req.valid.body.date ?? new Date();
  await assertCashOpen(from._id, date);
  await assertCashOpen(to._id, date);
  const balance = await cashBalance(from);
  if (amount > balance) throw httpError(409, 'INSUFFICIENT_CASH', `Saldo insuficiente en ${from.name} (${balance / 100}).`);
  const transferId = randomUUID();
  const concept = req.valid.body.concept ?? `Traslado ${from.name} → ${to.name}`;
  await withTransaction(async (session) => {
    await CashMovement.create([
      { cashAccountId: from._id, type: 'traslado_salida', amount, signedAmount: -amount, date, concept, transferId, counterpartCashAccountId: to._id, createdByMembershipId: req.membership._id },
      { cashAccountId: to._id, type: 'traslado_entrada', amount, signedAmount: amount, date, concept, transferId, counterpartCashAccountId: from._id, createdByMembershipId: req.membership._id },
    ], { session, ordered: true });
  });
  res.status(201).json({ transferId, amount });
});

/** Arqueos y cierres de la caja. */
router.get('/:id/closings', can('cash.read'), validate(idParam), async (req, res) => {
  res.json(await CashClosing.find({ cashAccountId: req.valid.params.id }).sort({ date: -1 }).limit(60));
});

/** Vista previa del cierre: cuánto debería haber en la caja al final del día. */
router.get('/:id/closings/preview', can('cash.read'), validate({ ...idParam, query: z.object({ date: z.coerce.date().optional() }) }), async (req, res) => {
  const cash = await loadCash(req.valid.params.id);
  const day = dayStart(req.valid.query.date ?? new Date());
  const last = await CashClosing.findOne({ cashAccountId: cash._id }).sort({ date: -1 });
  const periodFrom = last ? new Date(last.date.getTime() + 86_400_000) : null;
  const opening = last ? last.countedBalance : (cash.openingBalance ?? 0);
  const t = await cashTotals(cash._id, { from: periodFrom ?? undefined, to: dayEnd(day) });
  res.json({ date: day, periodFrom, lastClosingDate: last?.date ?? null, opening, ...t, expected: opening + t.payments + t.inflows - t.outflows });
});

router.post('/:id/closings', can('cash.update'), validate({
  ...idParam,
  body: z.object({ date: z.coerce.date().optional(), countedBalance: cents.or(z.literal(0)), notes: z.string().trim().max(500).optional() }),
}), async (req, res) => {
  const cash = await loadCash(req.valid.params.id);
  res.status(201).json(await closeCash(cash, { ...req.valid.body, membershipId: req.membership._id }));
});

export default router;
