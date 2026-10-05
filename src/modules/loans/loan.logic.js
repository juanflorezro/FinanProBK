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
    // Por defecto la mora se cobra solo sobre el capital vencido (cobrar interés sobre interés,
    // anatocismo, está restringido por ley en Colombia). Se puede cambiar por préstamo.
    const base = (inst.principalDue - inst.principalPaid)
      + (loan.lateInterestBase === 'capital_e_interes' ? inst.interestDue - inst.interestPaid : 0);
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
 * Abono extraordinario en planes fijos: anula las cuotas futuras sin pagos y devuelve el plan nuevo.
 * effect (Ley 1555 de 2012: el deudor elige):
 *  'reducir_cuota'  mismo número de cuotas, cuota más baja
 *  'reducir_plazo'  cuota igual o menor, menos cuotas (en cuota fija se compara la cuota total;
 *                   en capital fijo e interés simple, el abono a capital de cada cuota)
 */
export function rescheduleRows(loan, installments, asOf, effect = 'reducir_cuota') {
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

  const plan = (termCount) => buildSchedule({
    principal: principalForFuture,
    ratePerPeriod: loan.ratePerPeriod,
    amortization: loan.amortization,
    termCount,
    firstDueDate: future[0].dueDate,
    frequency: loan.frequency,
    interestBase: loan.interestBase,
    startNumber: future[0].number,
    // Interés simple (o base "capital inicial"): después de un abono a capital, el interés de las cuotas
    // nuevas se calcula sobre el capital que queda, no sobre el prestado al inicio: no se cobra
    // interés sobre dinero que el deudor ya devolvió.
    initialPrincipal: principalForFuture,
  });
  if (principalForFuture <= 0) return { cancel: future, rows: [] };

  let termCount = future.length;
  if (effect === 'reducir_plazo' && ['frances', 'aleman', 'interes_simple'].includes(loan.amortization)) {
    const old = future[0];
    const fits = (row) => (loan.amortization === 'frances'
      ? row.principalDue + row.interestDue <= old.principalDue + old.interestDue + 1
      : row.principalDue <= old.principalDue + 1);
    for (let n = 1; n <= future.length; n += 1) {
      if (fits(plan(n)[0])) { termCount = n; break; }
    }
  }
  return { cancel: future, rows: plan(termCount) };
}

/**
 * Liquidación (pago total anticipado) a una fecha. Ley 1555 de 2012: sin penalidad y con
 * intereses solo hasta el día del pago: el interés del período en curso se cobra por los días corridos.
 */
/** Días del período en curso de una cuota futura: desde el vencimiento anterior (o el desembolso). */
function periodOf(loan, active, next, asOf) {
  const prev = active.filter((i) => i.dueDate <= asOf && i._id !== next._id).at(-1);
  const start = prev?.dueDate ?? loan.disbursementDate ?? asOf;
  const days = Math.max(daysBetween(start, next.dueDate), 1);
  const elapsed = Math.min(Math.max(daysBetween(start, asOf), 0), days);
  return { start, days, elapsed };
}

/**
 * Liquidación (pago total anticipado) a una fecha. Ley 1555 de 2012: sin penalidad y con
 * intereses solo hasta el día del pago:
 *  - el interés del período en curso se cobra por los días corridos;
 *  - los intereses pagados por adelantado (de días que no corrieron o de cuotas futuras) se
 *    descuentan del capital; si superan el capital, quedan como saldo a favor del deudor.
 */
export function computePayoff(loan, installments, asOf) {
  const active = installments.filter((i) => !['anulada', 'condonada'].includes(i.status)).sort((a, b) => a.number - b.number);
  const open = active.filter((i) => i.status !== 'pagada');
  const exigible = open.filter((i) => i.dueDate <= asOf);
  const future = active.filter((i) => i.dueDate > asOf); // incluye cuotas futuras ya pagadas por adelantado
  const pend = (i, due, paid) => Math.max(i[due] - i[paid], 0);

  const late = sum(open, (i) => pend(i, 'lateInterestAccrued', 'lateInterestPaid'));
  const fees = sum(exigible, (i) => pend(i, 'feesDue', 'feesPaid'));
  const overdueInterest = sum(exigible, (i) => pend(i, 'interestDue', 'interestPaid'));
  const overduePrincipal = sum(exigible, (i) => pend(i, 'principalDue', 'principalPaid'));

  let periodInterest = 0;
  let currentInterest = 0;
  let prepaidInterestCredit = 0;
  let periodStart = null;
  const next = future[0];
  if (next) {
    const p = periodOf(loan, active, next, asOf);
    periodStart = p.start;
    periodInterest = Math.round(next.interestDue * p.elapsed / p.days);
    currentInterest = Math.max(periodInterest - next.interestPaid, 0);
    prepaidInterestCredit = Math.max(next.interestPaid - periodInterest, 0) + sum(future.slice(1), (i) => i.interestPaid);
  }
  const balance = Math.max(loan.balancePrincipal, 0);
  const principal = Math.max(balance - prepaidInterestCredit, 0);
  const refund = Math.max(prepaidInterestCredit - balance, 0);
  return {
    asOf, principal, overduePrincipal, overdueInterest, currentInterest, periodInterest, lateInterest: late, fees,
    prepaidInterestCredit, refund,
    total: Math.max(principal + overdueInterest + currentInterest + late + fees - refund, 0),
    periodStart, nextInstallmentId: next?._id ?? null,
  };
}

/**
 * Prepara las cuotas para la liquidación: la cuota del período en curso queda con el interés por
 * días corridos y todo el capital pendiente; las demás cuotas futuras se anulan y lo que ya se les
 * había pagado (capital e intereses adelantados) se abona al capital de la cuota en curso.
 * Devuelve las cuotas anuladas (el servicio las guarda).
 */
export function prepareLiquidation(loan, installments, asOf, payoff) {
  const active = installments.filter((i) => !['anulada', 'condonada'].includes(i.status)).sort((a, b) => a.number - b.number);
  const exigible = active.filter((i) => i.status !== 'pagada' && i.dueDate <= asOf);
  const future = active.filter((i) => i.dueDate > asOf);
  if (!future.length) return [];
  const [next, ...rest] = future;
  const exigiblePrincipal = sum(exigible, (i) => Math.max(i.principalDue - i.principalPaid, 0));

  // Intereses de más: los de días no corridos en la cuota en curso y todos los de cuotas futuras
  const extraInterest = Math.max(next.interestPaid - payoff.periodInterest, 0);
  const restInterest = sum(rest, (i) => i.interestPaid);
  const restPrincipal = sum(rest, (i) => i.principalPaid);
  const credit = extraInterest + restInterest;

  next.interestPaid -= extraInterest;
  next.interestDue = Math.max(payoff.periodInterest, next.interestPaid);
  next.principalPaid += restPrincipal + credit;            // se reclasifica como abono a capital
  loan.balancePrincipal = Math.max(loan.balancePrincipal - credit, 0);
  next.principalDue = next.principalPaid + Math.max(loan.balancePrincipal - exigiblePrincipal, 0);
  if (next.principalDue < next.principalPaid) next.principalDue = next.principalPaid;
  next.dueDate = asOf; // se vuelve exigible hoy
  next.status = 'pendiente';
  for (const i of rest) i.status = 'anulada';
  return rest;
}

/**
 * Después de un abono extraordinario a capital, ajusta el interés del período en curso por días:
 *  - abonos libres: el interés ya generado baja en lo que corresponde al abono por los días que faltan;
 *  - planes fijos: la cuota regenerada suma el interés del abono por los días que ya corrieron
 *    (el deudor tuvo ese dinero hasta hoy).
 * No baja de lo que ya se pagó de interés. regenerated indica si la cuota en curso se volvió a calcular.
 */
export function prorateAfterCapital(loan, installments, asOf, abono, { regenerated = false } = {}) {
  if (!abono || loan.interestBase === 'capital_inicial' && loan.amortization === 'abonos_libres') return null;
  const active = installments.filter((i) => !['anulada', 'condonada'].includes(i.status)).sort((a, b) => a.number - b.number);
  const current = active.find((i) => i.dueDate > asOf && i.status !== 'pagada');
  if (!current) return null;
  const { days, elapsed } = periodOf(loan, active, current, asOf);
  const rate = Number(loan.ratePerPeriod) / 100;
  if (loan.amortization === 'abonos_libres') {
    const reduce = Math.round(abono * rate * (days - elapsed) / days);
    current.interestDue = Math.max(current.interestDue - reduce, current.interestPaid);
  } else if (regenerated) {
    current.interestDue += Math.round(abono * rate * elapsed / days);
  }
  return current;
}
