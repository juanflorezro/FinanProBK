import { Loan, OPEN_STATUS } from '../loans/loan.model.js';
import { Payment } from './payment.model.js';
import { PaymentAllocation } from './paymentAllocation.model.js';
import { nextSeq } from '../counters/counter.model.js';
import { withTransaction } from '../../db/withTransaction.js';
import { getContext } from '../../db/context.js';
import { allocatePayment, DEFAULT_WATERFALL, FIELDS } from './allocation.js';
import { accrueLateInterest, recomputeSummary, nextRollingRows, computePayoff, prepareLiquidation } from '../loans/loan.logic.js';
import { assertCashOpen } from '../cash/cash.service.js';
import { getInstallments, createInstallments, saveModified, applyReschedule, httpError } from '../loans/loan.service.js';

const fmt = (c) => `$${(c / 100).toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;
export const APPLY_MODES = ['automatico', 'cuotas', 'intereses', 'capital', 'liquidacion'];

/**
 * Registra un pago en una sola transacción:
 * idempotencia → caja abierta → mora al día → aplicación según modalidad → (replanificación) → recibo → resumen.
 *
 * applyTo: 'automatico' | 'cuotas' (targetNumbers) | 'intereses' | 'capital' (capitalEffect) | 'liquidacion'
 * capitalEffect (Ley 1555 de 2012, lo elige el deudor): 'reducir_cuota' | 'reducir_plazo'
 */
export function registerPayment(input, { waterfall = DEFAULT_WATERFALL, excessMode } = {}) {
  const {
    loanId, amount, method, cashAccountId, idempotencyKey,
    paidAt = new Date(), valueDate, channel = 'oficina', externalReference,
    applyTo = 'automatico', targetNumbers = [], components = [], capitalEffect = 'reducir_cuota', notes,
  } = input;
  if (!APPLY_MODES.includes(applyTo)) throw httpError(400, 'INVALID_APPLY_MODE', 'Modalidad de pago inválida');

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw httpError(400, 'INVALID_AMOUNT', 'El monto debe ser un entero positivo en centavos');
  }
  if (!idempotencyKey) throw httpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Falta idempotencyKey');

  return withTransaction(async (session) => {
    const existing = await Payment.findOne({ idempotencyKey }).session(session);
    if (existing) return existing;

    const loan = await Loan.findById(loanId).session(session);
    if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
    if (!OPEN_STATUS.includes(loan.status)) {
      throw httpError(409, 'LOAN_NOT_OPEN', `No se reciben pagos en estado ${loan.status}`);
    }

    await assertCashOpen(cashAccountId, paidAt, session);
    const asOf = new Date(valueDate ?? paidAt);
    let installments = await getInstallments(loan, session);
    accrueLateInterest(loan, installments, asOf);

    const open = installments.filter((i) => !['pagada', 'anulada', 'condonada'].includes(i.status));
    const overdue = open.filter((i) => i.dueDate <= asOf).reduce((a, i) => a + i.pending, 0);
    let mode = applyTo;
    let liquidation = null;

    if (applyTo === 'cuotas') {
      const valid = new Set(open.map((i) => i.number));
      const bad = targetNumbers.filter((n) => !valid.has(Number(n)));
      if (!targetNumbers.length) throw httpError(400, 'INSTALLMENTS_REQUIRED', 'Elige las cuotas a pagar');
      if (bad.length) throw httpError(400, 'INSTALLMENT_NOT_OPEN', `Las cuotas ${bad.join(', ')} no están pendientes`);
    }
    if (applyTo === 'capital') {
      if (overdue > 0) throw httpError(409, 'OVERDUE_FIRST', `Para abonar a capital el préstamo debe estar al día. Primero paga lo vencido: ${fmt(overdue)}.`);
      if (amount >= loan.balancePrincipal) throw httpError(400, 'USE_LIQUIDATION', `El abono cubre todo el capital (${fmt(loan.balancePrincipal)}). Usa "pago total" para liquidar el préstamo con los intereses al día.`);
    }
    if (applyTo === 'liquidacion') {
      liquidation = computePayoff(loan, installments, asOf);
      if (amount < liquidation.total) throw httpError(400, 'PAYOFF_NOT_COVERED', `Para pagar el total a hoy se necesitan ${fmt(liquidation.total)}.`);
      const cancelled = prepareLiquidation(loan, installments, asOf, liquidation);
      await saveModified(cancelled, session);
      installments = installments.filter((i) => i.status !== 'anulada');
      mode = 'automatico';
    }

    const { allocations, totals, unapplied, needsReschedule } = allocatePayment({
      loan, installments, amount, asOf, waterfall, excessMode: liquidation ? 'proximas_cuotas' : excessMode, applyTo: mode, targetNumbers,
      components: applyTo === 'cuotas' ? components : [],
    });
    if (applyTo === 'cuotas' && components.length && unapplied > 0) {
      const names = { interes: 'intereses', mora: 'mora', cargo: 'cargos', capital: 'capital' };
      throw httpError(400, 'COMPONENT_EXCEEDED', `En esas cuotas solo hay ${fmt(amount - unapplied)} de ${components.map((c) => names[c]).join(' y ')} por pagar.`);
    }
    if (applyTo === 'intereses' && unapplied > 0) {
      throw httpError(400, 'INTEREST_EXCEEDED', `Solo hay ${fmt(amount - unapplied)} de intereses y mora para pagar hoy. Para abonar el resto usa "abono a capital" o "automático".`);
    }
    loan.balancePrincipal -= totals.capital;

    if (needsReschedule) installments = await applyReschedule(loan, installments, asOf, session, capitalEffect);
    const rolling = await createInstallments(loan, nextRollingRows(loan, installments, asOf), session);
    installments = [...installments, ...rolling];

    const receiptNumber = await nextSeq(loan.orgId, 'receipt', session);
    const [payment] = await Payment.create([{
      orgId: loan.orgId,
      receiptNumber,
      loanId: loan._id,
      borrowerId: loan.borrowerId,
      cashAccountId,
      receivedBy: getContext().membershipId,
      amount,
      currency: loan.currency,
      method,
      channel,
      externalReference,
      idempotencyKey,
      paidAt,
      valueDate: asOf,
      appliedLateInterest: totals.mora,
      appliedFees: totals.cargo,
      appliedInterest: totals.interes,
      appliedPrincipal: totals.capital,
      unappliedAmount: unapplied,
      triggeredReschedule: needsReschedule || Boolean(liquidation),
      applyTo,
      capitalEffect: applyTo === 'capital' ? capitalEffect : undefined,
      targetNumbers: applyTo === 'cuotas' ? targetNumbers.map(Number) : undefined,
      components: applyTo === 'cuotas' && components.length ? components : undefined,
      notes,
    }], { session, ordered: true });

    await PaymentAllocation.create(
      allocations.map((a) => ({ ...a, orgId: loan.orgId, paymentId: payment._id, loanId: loan._id })),
      { session, ordered: true },
    );

    loan.totalPaid += amount;
    loan.lastPaymentAt = paidAt;
    recomputeSummary(loan, installments, asOf);
    await saveModified(installments, session);
    await loan.save({ session });
    return payment;
  });
}

/** Reversa un pago: pago espejo negativo, devuelve saldos a las cuotas. Nunca borra. */
export function reversePayment(paymentId, reason) {
  if (!reason) throw httpError(400, 'REASON_REQUIRED', 'Indica el motivo del reverso');

  return withTransaction(async (session) => {
    const original = await Payment.findById(paymentId).session(session);
    if (!original) throw httpError(404, 'PAYMENT_NOT_FOUND', 'Pago no encontrado');
    if (original.isReversal || original.status === 'reversado') {
      throw httpError(409, 'PAYMENT_ALREADY_REVERSED', 'Este pago ya fue reversado o es un reverso');
    }
    if (original.triggeredReschedule) {
      throw httpError(409, 'PAYMENT_RESCHEDULED', 'Este pago cambió el plan de cuotas (abono a capital o pago total). Para anularlo, pide a soporte la corrección.');
    }

    await assertCashOpen(original.cashAccountId, new Date(), session);
    const loan = await Loan.findById(original.loanId).session(session);
    const allocations = await PaymentAllocation.find({ paymentId: original._id }).session(session);
    const installments = await getInstallments(loan, session);
    const byId = new Map(installments.map((i) => [String(i._id), i]));

    for (const a of allocations) {
      if (!a.installmentId) continue;
      const inst = byId.get(String(a.installmentId));
      if (!inst) throw httpError(409, 'INSTALLMENT_MISSING', 'La cuota del pago ya no está activa');
      inst[FIELDS[a.component][1]] -= a.amount;
      if (inst.status === 'pagada') inst.status = 'pendiente';
    }
    loan.balancePrincipal += original.appliedPrincipal;
    loan.totalPaid -= original.amount;

    const receiptNumber = await nextSeq(loan.orgId, 'receipt', session);
    const [reversal] = await Payment.create([{
      orgId: loan.orgId,
      receiptNumber,
      loanId: loan._id,
      borrowerId: loan.borrowerId,
      cashAccountId: original.cashAccountId,
      receivedBy: getContext().membershipId,
      amount: -original.amount,
      currency: original.currency,
      method: original.method,
      channel: original.channel,
      idempotencyKey: `rev:${original._id}`,
      paidAt: new Date(),
      valueDate: original.valueDate,
      isReversal: true,
      reversalOfId: original._id,
      reversalReason: reason,
      appliedLateInterest: -original.appliedLateInterest,
      appliedFees: -original.appliedFees,
      appliedInterest: -original.appliedInterest,
      appliedPrincipal: -original.appliedPrincipal,
      unappliedAmount: -original.unappliedAmount,
    }], { session, ordered: true });

    await PaymentAllocation.create(
      allocations.map((a) => ({
        orgId: loan.orgId, paymentId: reversal._id, loanId: loan._id,
        installmentId: a.installmentId, chargeId: a.chargeId,
        component: a.component, amount: -a.amount, order: a.order,
      })),
      { session, ordered: true },
    );

    original.status = 'reversado';
    original.reversedById = reversal._id;
    original.reversalReason = reason;
    await original.save({ session });

    if (loan.status === 'pagado') loan.status = 'al_dia';
    recomputeSummary(loan, installments, new Date());
    await saveModified(installments, session);
    await loan.save({ session });
    return reversal;
  });
}
