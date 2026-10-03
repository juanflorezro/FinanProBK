import { buildSchedule, lateInterestFor } from './schedule.js';
import { addDays, addPeriods, daysBetween, startOfDay } from '../../utils/dates.js';
import { effectiveForPeriod } from '../../utils/rates.js';

// Lógica pura sobre documentos ya cargados (sin consultas). Fácil de probar.

const CLOSED = ['pagada', 'anulada', 'condonada'];
const sum = (arr, f) => arr.reduce((acc, x) => acc + f(x), 0);

export const bucketFor = (dpd) =>
  dpd <= 0 ? '0' : dpd <= 30 ? '1-30' : dpd <= 60 ? '31-60' : dpd <= 90 ? '61-90' : '90+';

/** Causa la mora de cada cuota vencida hasta asOf (incremental, idempotente por día). */
export function accrueLateInterest(loan, installments, asOf) {
  if (!loan.lateRate || Number(loan.lateRate) === 0) return;
  const daily = effectiveForPeriod(loan.lateRate, loan.lateRateBasis, 'efectiva', 'diaria', loan.frequency);

  for (const inst of installments) {
    if (CLOSED.includes(inst.status)) continue;
    const graceEnd = addDays(inst.dueDate, loan.graceDays ?? 0);
    if (asOf <= graceEnd) continue;
    const from = inst.lateAccruedUntil ?? inst.dueDate;
    const days = daysBetween(from, asOf);
    const base = (inst.principalDue - inst.principalPaid) + (inst.interestDue - inst.interestPaid);
    const amount = lateInterestFor({ overdueBase: base, dailyRate: daily, days });
    if (amount > 0) inst.lateInterestAccrued += amount;
    inst.lateAccruedUntil = startOfDay(asOf);
  }
}

/** Recalcula estados de cuotas y el resumen del préstamo. */
export function recomputeSummary(loan, installments, asOf = new Date()) {
  const active = installments.filter((i) => !['anulada', 'condonada'].includes(i.status));
  for (const inst of active) inst.refreshStatus(asOf);

  const open = active.filter((i) => i.status !== 'pagada');
  const due = open.filter((i) => i.dueDate <= asOf);

  loan.balanceInterest = sum(due, (i) => i.interestDue - i.interestPaid);
  loan.balanceFees = sum(due, (i) => i.feesDue - i.feesPaid);
  loan.balanceLateInterest = sum(open, (i) => i.lateInterestAccrued - i.lateInterestPaid);
  loan.daysPastDue = due.reduce((m, i) => Math.max(m, i.daysPastDue), 0);
  loan.agingBucket = bucketFor(loan.daysPastDue);

  const next = [...open].sort((a, b) => a.dueDate - b.dueDate)[0];
  loan.nextDueDate = next?.dueDate;
  loan.nextDueAmount = next ? next.pending : 0;

  if (loan.balancePrincipal <= 0 && open.length === 0) {
    loan.status = 'pagado';
    loan.closedAt ??= asOf;
    loan.nextDueDate = undefined;
    loan.nextDueAmount = 0;
  } else if (['desembolsado', 'al_dia', 'en_mora', 'pagado'].includes(loan.status)) {
    loan.status = loan.daysPastDue > 0 ? 'en_mora' : 'al_dia';
    loan.closedAt = undefined;
  }
  return loan;
}

/**
 * Abonos libres: mantiene siempre una cuota de interés del período en curso.
 * Devuelve los datos de las cuotas nuevas que hay que crear (sin guardarlas).
 */
export function nextRollingRows(loan, installments, asOf) {
  if (loan.amortization !== 'abonos_libres' || loan.balancePrincipal <= 0) return [];
  const active = installments.filter((i) => i.status !== 'anulada').sort((a, b) => a.number - b.number);
  let last = active.at(-1);
  const rows = [];
  while (last && last.dueDate <= asOf) {
    const [row] = buildSchedule({
      principal: loan.balancePrincipal,
      initialPrincipal: loan.principal,
      ratePerPeriod: loan.ratePerPeriod,
      amortization: 'abonos_libres',
      firstDueDate: addPeriods(last.dueDate, loan.frequency, 1),
      frequency: loan.frequency,
      interestBase: loan.interestBase,
      startNumber: last.number + 1,
    });
    rows.push(row);
    last = row;
  }
  return rows;
}

/**
 * Abono extraordinario en planes fijos: anula las cuotas futuras sin pagos
 * y devuelve el plan nuevo con el mismo número de cuotas (reduce la cuota).
 */
export function rescheduleRows(loan, installments, asOf) {
  const active = installments.filter((i) => !['anulada', 'condonada'].includes(i.status));
  const future = active
    .filter((i) => i.dueDate > asOf && i.totalPaid === 0)
    .sort((a, b) => a.number - b.number);
  if (!future.length) return { cancel: [], rows: [] };

  const futureIds = new Set(future.map((i) => String(i._id)));
  const pendingOutside = sum(
    active.filter((i) => !futureIds.has(String(i._id))),
    (i) => i.principalDue - i.principalPaid,
  );
  const principalForFuture = loan.balancePrincipal - pendingOutside;

  const rows = principalForFuture > 0
    ? buildSchedule({
      principal: principalForFuture,
      ratePerPeriod: loan.ratePerPeriod,
      amortization: loan.amortization,
      termCount: future.length,
      firstDueDate: future[0].dueDate,
      frequency: loan.frequency,
      interestBase: loan.interestBase,
      startNumber: future[0].number,
      initialPrincipal: loan.principal,
    })
    : [];
  return { cancel: future, rows };
}
