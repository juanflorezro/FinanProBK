import { Payment } from '../payments/payment.model.js';
import { CashAccount } from './cashAccount.model.js';
import { CashMovement, CashClosing } from './cash.models.js';
import { httpError } from '../../utils/errors.js';

const dayStart = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
const dayEnd = (d) => { const x = new Date(d); x.setUTCHours(23, 59, 59, 999); return x; };

/** No se registra nada con fecha igual o anterior al último cierre de la caja. */
export async function assertCashOpen(cashAccountId, date, session) {
  const last = await CashClosing.findOne({ cashAccountId }).sort({ date: -1 }).session(session ?? null);
  if (last && dayStart(date) <= last.date) {
    throw httpError(409, 'CASH_CLOSED', `La caja ya está cerrada hasta el ${last.date.toISOString().slice(0, 10)}. Registra con fecha posterior o pide reabrir el cierre.`);
  }
}

/** Totales de una caja entre dos fechas (incluidas), opcionalmente hasta un instante. */
export async function cashTotals(cashAccountId, { from, to } = {}) {
  const range = (field) => (from || to ? { [field]: { ...(from && { $gte: from }), ...(to && { $lte: to }) } } : {});
  const [pay, byMethod, mov] = await Promise.all([
    Payment.aggregate([{ $match: { cashAccountId, ...range('paidAt') } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: { $cond: ['$isReversal', 0, 1] } } } }]),
    Payment.aggregate([{ $match: { cashAccountId, ...range('paidAt') } }, { $group: { _id: '$method', total: { $sum: '$amount' } } }]),
    CashMovement.aggregate([{ $match: { cashAccountId, voidedAt: null, ...range('date') } }, { $group: { _id: { $gt: ['$signedAmount', 0] }, total: { $sum: '$signedAmount' } } }]),
  ]);
  const inflows = mov.find((m) => m._id === true)?.total ?? 0;
  const outflows = -(mov.find((m) => m._id === false)?.total ?? 0);
  return {
    payments: pay[0]?.total ?? 0, paymentsCount: pay[0]?.count ?? 0, inflows, outflows,
    byMethod: Object.fromEntries(byMethod.map((m) => [m._id, m.total])),
  };
}

/** Saldo de la caja hasta una fecha (fin del día). */
export async function cashBalance(account, until = new Date()) {
  const t = await cashTotals(account._id, { to: dayEnd(until) });
  return (account.openingBalance ?? 0) + t.payments + t.inflows - t.outflows;
}

export async function cashHasActivity(cashAccountId) {
  const [p, m] = await Promise.all([
    Payment.exists({ cashAccountId }).setOptions({ withDeleted: true }),
    CashMovement.exists({ cashAccountId }).setOptions({ withDeleted: true }),
  ]);
  return { payments: Boolean(p), movements: Boolean(m) };
}

/** Arqueo y cierre: compara el saldo esperado con lo contado y bloquea las fechas anteriores. */
export async function closeCash(account, { date = new Date(), countedBalance, notes, membershipId }) {
  const day = dayStart(date);
  if (day > dayStart(new Date())) throw httpError(400, 'FUTURE_DATE', 'No puedes cerrar una fecha futura');
  const last = await CashClosing.findOne({ cashAccountId: account._id }).sort({ date: -1 });
  if (last && day <= last.date) throw httpError(409, 'ALREADY_CLOSED', `Ya existe un cierre al ${last.date.toISOString().slice(0, 10)}`);

  const periodFrom = last ? new Date(last.date.getTime() + 86_400_000) : null;
  const openingBalance = last ? last.countedBalance : (account.openingBalance ?? 0);
  const t = await cashTotals(account._id, { from: periodFrom ?? undefined, to: dayEnd(day) });
  const expectedBalance = openingBalance + t.payments + t.inflows - t.outflows;
  const difference = countedBalance - expectedBalance;

  const closing = await CashClosing.create({
    cashAccountId: account._id, date: day, periodFrom, openingBalance, payments: t.payments, inflows: t.inflows,
    outflows: t.outflows, expectedBalance, countedBalance, difference, byMethod: t.byMethod, paymentsCount: t.paymentsCount,
    notes, closedByMembershipId: membershipId,
  });
  // La diferencia queda registrada como ajuste para que el saldo siguiente parta de lo contado
  if (difference !== 0) {
    await CashMovement.create({
      cashAccountId: account._id, type: 'ajuste_arqueo', amount: Math.abs(difference), signedAmount: difference,
      date: dayEnd(day), concept: difference > 0 ? 'Sobrante de arqueo' : 'Faltante de arqueo', closingId: closing._id,
      createdByMembershipId: membershipId,
    });
  }
  return closing;
}

export { CashAccount, dayStart, dayEnd };
