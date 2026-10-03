import { Loan, OPEN_STATUS } from './loan.model.js';
import { Installment } from './installment.model.js';
import { LoanRateChange } from './loanRateChange.model.js';
import { buildSchedule } from './schedule.js';
import { accrueLateInterest, recomputeSummary, nextRollingRows, rescheduleRows } from './loan.logic.js';
import { addPeriods } from '../../utils/dates.js';
import { withTransaction } from '../../db/withTransaction.js';

import { httpError } from '../../utils/errors.js';

export { httpError };

export function getInstallments(loan, session) {
  return Installment.find({ loanId: loan._id, status: { $ne: 'anulada' } })
    .sort({ number: 1 })
    .session(session);
}

export async function createInstallments(loan, rows, session) {
  if (!rows.length) return [];
  return Installment.create(
    rows.map((r) => ({ ...r, orgId: loan.orgId, loanId: loan._id, scheduleVersion: loan.scheduleVersion })),
    { session, ordered: true },
  );
}

export async function saveModified(docs, session) {
  for (const d of docs) if (d.isNew || d.isModified()) await d.save({ session });
}

/** Desembolsa: genera el plan, registra la tasa pactada y deja el préstamo al día. */
export function disburseLoan(loanId, { disbursementDate = new Date(), firstDueDate } = {}) {
  return withTransaction(async (session) => {
    const loan = await Loan.findById(loanId).session(session);
    if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
    if (!['solicitud', 'aprobado'].includes(loan.status)) {
      throw httpError(409, 'LOAN_NOT_DISBURSABLE', `No se puede desembolsar un préstamo en estado ${loan.status}`);
    }

    const date = new Date(disbursementDate);
    const first = firstDueDate ? new Date(firstDueDate) : addPeriods(date, loan.frequency, 1);
    const rows = buildSchedule({
      principal: loan.principal,
      ratePerPeriod: loan.ratePerPeriod,
      amortization: loan.amortization,
      termCount: loan.termCount,
      firstDueDate: first,
      frequency: loan.frequency,
      interestBase: loan.interestBase,
    });
    await createInstallments(loan, rows, session);

    const [rateChange] = await LoanRateChange.create([{
      orgId: loan.orgId,
      loanId: loan._id,
      sequence: 1,
      rate: loan.rate,
      rateBasis: loan.rateBasis,
      rateKind: loan.rateKind,
      lateRate: loan.lateRate,
      frequency: loan.frequency,
      effectiveFrom: date,
      fromInstallmentNumber: 1,
      reason: 'pactada',
    }], { session, ordered: true });

    loan.currentRateChangeId = rateChange._id;
    loan.disbursementDate = date;
    loan.firstDueDate = first;
    loan.maturityDate = loan.amortization === 'abonos_libres' ? undefined : rows.at(-1).dueDate;
    loan.balancePrincipal = loan.principal;
    loan.status = 'desembolsado';

    const installments = await getInstallments(loan, session);
    recomputeSummary(loan, installments, date);
    await saveModified(installments, session);
    await loan.save({ session });
    return loan;
  });
}

/** Pone al día un préstamo: mora causada, cuota rodante de abonos libres y estado. */
export function refreshLoan(loanId, asOf = new Date()) {
  return withTransaction(async (session) => {
    const loan = await Loan.findById(loanId).session(session);
    if (!loan || !OPEN_STATUS.includes(loan.status)) return loan;
    let installments = await getInstallments(loan, session);
    accrueLateInterest(loan, installments, asOf);
    const created = await createInstallments(loan, nextRollingRows(loan, installments, asOf), session);
    installments = [...installments, ...created];
    recomputeSummary(loan, installments, asOf);
    await saveModified(installments, session);
    await loan.save({ session });
    return loan;
  });
}

/** Abono extraordinario en plan fijo: regenera las cuotas futuras. Usar dentro de una transacción. */
export async function applyReschedule(loan, installments, asOf, session) {
  const { cancel, rows } = rescheduleRows(loan, installments, asOf);
  if (!cancel.length) return installments;
  for (const inst of cancel) inst.status = 'anulada';
  await saveModified(cancel, session);
  loan.scheduleVersion += 1;
  const created = await createInstallments(loan, rows, session);
  const cancelled = new Set(cancel.map((i) => String(i._id)));
  return [...installments.filter((i) => !cancelled.has(String(i._id))), ...created];
}
