import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { httpError } from '../../utils/errors.js';
import { objectId, cents, rateValue } from '../../utils/schemas.js';
import { documentHash } from '../../utils/crypto.js';
import { RATE_BASES, FREQUENCIES, deriveRates } from '../../utils/rates.js';
import { addPeriods } from '../../utils/dates.js';
import { withTransaction } from '../../db/withTransaction.js';
import { audit } from '../audit/audit.service.js';
import { Borrower } from '../borrowers/borrower.model.js';
import { Loan, OPEN_STATUS, AMORTIZATION } from '../loans/loan.model.js';
import { Installment } from '../loans/installment.model.js';
import { LoanRateChange } from '../loans/loanRateChange.model.js';
import { Payment, PAYMENT_METHODS } from '../payments/payment.model.js';
import { CashAccount } from '../cash/cashAccount.model.js';
import { buildSchedule } from '../loans/schedule.js';
import { recomputeSummary } from '../loans/loan.logic.js';
import { getInstallments, createInstallments, saveModified } from '../loans/loan.service.js';
import { reversePayment } from '../payments/payment.service.js';

/**
 * Correcciones de soporte sobre los datos de una organización.
 * Se monta dentro de /admin/organizations/:id/support y exige acceso con permiso de escritura
 * (lo valida requireSupport('escritura') al montar). Todo queda en la bitácora con antes y después.
 */
const router = Router({ mergeParams: true });
const reason = z.string().trim().min(5, 'Escribe el motivo (mínimo 5 caracteres)').max(500);
const pick = (doc, keys) => Object.fromEntries(keys.map((k) => [k, doc?.[k]]));

const log = (req, action, entity, entityId, before, after) =>
  audit(req, { action, entity, entityId, orgId: req.supportGrant.orgId, supportGrantId: req.supportGrant._id, before, after });

// ---------------------------------------------------------------- Deudores
const BORROWER_FIELDS = ['docType', 'docNumber', 'firstName', 'lastName', 'phone', 'phoneAlt', 'email', 'address', 'neighborhood', 'city', 'occupation', 'riskRating', 'status'];

router.patch('/borrowers/:borrowerId', validate({
  params: z.object({ id: objectId, borrowerId: objectId }),
  body: z.object({
    docType: z.enum(['CC', 'CE', 'PPT', 'PAS', 'NIT']).optional(),
    docNumber: z.string().trim().regex(/^[0-9A-Za-z-]{4,20}$/, 'Documento inválido').optional(),
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().min(1).max(60).optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    phoneAlt: z.string().trim().max(20).optional(),
    email: z.string().trim().toLowerCase().email().or(z.literal('')).optional(),
    address: z.string().trim().max(200).optional(),
    neighborhood: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    occupation: z.string().trim().max(80).optional(),
    riskRating: z.enum(['A', 'B', 'C', 'D']).optional(),
    status: z.enum(['activo', 'inactivo', 'bloqueado']).optional(),
    reason,
  }),
}), async (req, res) => {
  const { reason: why, ...changes } = req.valid.body;
  const b = await Borrower.findById(req.valid.params.borrowerId);
  if (!b) throw httpError(404, 'BORROWER_NOT_FOUND', 'Deudor no encontrado');
  const before = pick(b, BORROWER_FIELDS);
  b.set(changes);
  if (changes.docType || changes.docNumber) b.docNumberHash = documentHash(b.orgId, b.docType, b.docNumber);
  await b.save();
  await log(req, 'support.edit_borrower', 'Borrower', b._id, before, { ...pick(b, BORROWER_FIELDS), reason: why });
  res.json(b);
});

// ---------------------------------------------------------------- Préstamo: datos que no tocan el plan
const LOAN_SAFE = ['notes', 'graceDays', 'lateRate', 'lateRateBasis', 'lateInterestBase', 'lendingRegime', 'status'];

router.patch('/loans/:loanId', validate({
  params: z.object({ id: objectId, loanId: objectId }),
  body: z.object({
    notes: z.string().max(1000).optional(),
    graceDays: z.number().int().min(0).max(90).optional(),
    lateRate: rateValue.optional(),
    lateRateBasis: z.enum(RATE_BASES).optional(),
    lateInterestBase: z.enum(['capital', 'capital_e_interes']).optional(),
    lendingRegime: z.enum(['formal', 'informal']).optional(),
    status: z.enum(['solicitud', 'aprobado', 'castigado', 'anulado']).optional(), // estados manuales
    reason,
  }),
}), async (req, res) => {
  const { reason: why, ...changes } = req.valid.body;
  const loan = await Loan.findById(req.valid.params.loanId);
  if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
  if (changes.status && ['solicitud', 'aprobado'].includes(changes.status) && OPEN_STATUS.includes(loan.status)) {
    throw httpError(409, 'INVALID_STATUS', 'Un préstamo desembolsado no puede volver a solicitud; usa "Corregir condiciones"');
  }
  const before = pick(loan, LOAN_SAFE);
  loan.set(changes);
  if (['castigado', 'anulado'].includes(changes.status)) loan.closedAt ??= new Date();
  await loan.save();
  await log(req, 'support.edit_loan', 'Loan', loan._id, before, { ...pick(loan, LOAN_SAFE), reason: why });
  res.json(loan);
});

// ---------------------------------------------------------------- Préstamo: corregir condiciones y rehacer el plan
router.post('/loans/:loanId/replan', validate({
  params: z.object({ id: objectId, loanId: objectId }),
  body: z.object({
    principal: cents,
    rate: rateValue,
    rateBasis: z.enum(RATE_BASES),
    rateKind: z.enum(['nominal', 'efectiva']).default('efectiva'),
    interestBase: z.enum(['saldo_capital', 'capital_inicial']).default('saldo_capital'),
    amortization: z.enum(AMORTIZATION),
    frequency: z.enum(FREQUENCIES),
    termCount: z.number().int().min(1).max(600).optional(),
    disbursementDate: z.coerce.date().optional(),
    firstDueDate: z.coerce.date().optional(),
    reason,
  }).refine((b) => b.amortization === 'abonos_libres' || b.termCount, { path: ['termCount'], message: 'Indica el número de cuotas' }),
}), async (req, res) => {
  const { reason: why, disbursementDate, firstDueDate, ...terms } = req.valid.body;
  const KEYS = ['principal', 'rate', 'rateBasis', 'rateKind', 'interestBase', 'amortization', 'frequency', 'termCount', 'disbursementDate', 'firstDueDate'];

  const result = await withTransaction(async (session) => {
    const loan = await Loan.findById(req.valid.params.loanId).session(session);
    if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
    if (await Payment.exists({ loanId: loan._id, isReversal: false, status: 'aplicado' }).session(session)) {
      throw httpError(409, 'LOAN_HAS_PAYMENTS', 'Este préstamo tiene pagos aplicados. Reversa primero los pagos y luego corrige las condiciones.');
    }
    const before = pick(loan, KEYS);
    const rateChanged = String(terms.rate) !== String(loan.rate) || terms.rateBasis !== loan.rateBasis || terms.frequency !== loan.frequency;
    loan.set({ ...terms, termCount: terms.amortization === 'abonos_libres' ? undefined : terms.termCount });

    if (OPEN_STATUS.includes(loan.status)) {
      const old = await getInstallments(loan, session);
      for (const i of old) i.status = 'anulada';
      await saveModified(old, session);
      if (disbursementDate) loan.disbursementDate = disbursementDate;
      const first = firstDueDate ?? addPeriods(loan.disbursementDate, loan.frequency, 1);
      const rows = buildSchedule({ ...terms, ratePerPeriod: deriveRates(terms).ratePerPeriod, firstDueDate: first });
      loan.scheduleVersion += 1;
      loan.firstDueDate = first;
      loan.maturityDate = loan.amortization === 'abonos_libres' ? undefined : rows.at(-1).dueDate;
      Object.assign(loan, { balancePrincipal: loan.principal, balanceInterest: 0, balanceLateInterest: 0, balanceFees: 0, daysPastDue: 0 });
      const created = await createInstallments(loan, rows, session);
      loan.status = 'al_dia';
      recomputeSummary(loan, created, new Date());
      await saveModified(created, session);
    }
    if (rateChanged) {
      const seq = (await LoanRateChange.countDocuments({ loanId: loan._id }).session(session)) + 1;
      const [rc] = await LoanRateChange.create([{
        orgId: loan.orgId, loanId: loan._id, sequence: seq, rate: terms.rate, rateBasis: terms.rateBasis, rateKind: terms.rateKind,
        lateRate: loan.lateRate, frequency: terms.frequency, effectiveFrom: loan.disbursementDate ?? new Date(), fromInstallmentNumber: 1,
        reason: 'otro', notes: `Corrección de soporte: ${why}`,
      }], { session, ordered: true });
      loan.currentRateChangeId = rc._id;
    }
    await loan.save({ session });
    return { loan, before };
  });
  await log(req, 'support.replan_loan', 'Loan', result.loan._id, result.before, { ...pick(result.loan, KEYS), reason: why });
  res.json(result.loan);
});

// ---------------------------------------------------------------- Cuota: fecha, condonar saldo o mora
router.patch('/loans/:loanId/installments/:installmentId', validate({
  params: z.object({ id: objectId, loanId: objectId, installmentId: objectId }),
  body: z.object({
    dueDate: z.coerce.date().optional(),
    waive: z.number().int().min(1).optional(),   // centavos a condonar del saldo pendiente
    resetLateInterest: z.boolean().optional(),   // borra la mora causada y no pagada
    reason,
  }).refine((b) => b.dueDate || b.waive || b.resetLateInterest, 'Indica qué quieres corregir'),
}), async (req, res) => {
  const { loanId, installmentId } = req.valid.params;
  const { dueDate, waive, resetLateInterest, reason: why } = req.valid.body;
  const KEYS = ['dueDate', 'waived', 'lateInterestAccrued', 'status'];

  const out = await withTransaction(async (session) => {
    const loan = await Loan.findById(loanId).session(session);
    if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
    const installments = await getInstallments(loan, session);
    const inst = installments.find((i) => String(i._id) === installmentId);
    if (!inst) throw httpError(404, 'INSTALLMENT_NOT_FOUND', 'Cuota no encontrada');
    const before = pick(inst, KEYS);
    if (resetLateInterest) {
      inst.lateInterestAccrued = inst.lateInterestPaid;
      inst.lateAccruedUntil = new Date();
    }
    if (dueDate) {
      inst.dueDate = dueDate;
      inst.lateAccruedUntil = undefined;
    }
    if (waive) {
      if (waive > inst.pending) throw httpError(400, 'WAIVE_TOO_HIGH', 'No puedes condonar más de lo que falta por pagar en la cuota');
      inst.waived += waive;
    }
    recomputeSummary(loan, installments, new Date());
    await saveModified(installments, session);
    await loan.save({ session });
    return { before, inst };
  });
  await log(req, 'support.edit_installment', 'Installment', out.inst._id, out.before, { ...pick(out.inst, KEYS), reason: why });
  res.json(out.inst);
});

// ---------------------------------------------------------------- Pagos: datos sin efecto en saldos, o reversar
router.patch('/payments/:paymentId', validate({
  params: z.object({ id: objectId, paymentId: objectId }),
  body: z.object({
    method: z.enum(PAYMENT_METHODS).optional(),
    externalReference: z.string().trim().max(80).optional(),
    cashAccountId: objectId.optional(),
    reason,
  }),
}), async (req, res) => {
  const { reason: why, ...changes } = req.valid.body;
  const p = await Payment.findById(req.valid.params.paymentId);
  if (!p) throw httpError(404, 'PAYMENT_NOT_FOUND', 'Pago no encontrado');
  if (changes.cashAccountId && !(await CashAccount.exists({ _id: changes.cashAccountId }))) throw httpError(404, 'CASH_ACCOUNT_NOT_FOUND', 'Caja no encontrada');
  const before = pick(p, ['method', 'externalReference', 'cashAccountId']);
  p.set(changes);
  await p.save();
  await log(req, 'support.edit_payment', 'Payment', p._id, before, { ...pick(p, ['method', 'externalReference', 'cashAccountId']), reason: why });
  res.json(p);
});

router.post('/payments/:paymentId/reverse', validate({
  params: z.object({ id: objectId, paymentId: objectId }),
  body: z.object({ reason }),
}), async (req, res) => {
  const reversal = await reversePayment(req.valid.params.paymentId, `Soporte FinanPro: ${req.valid.body.reason}`);
  await log(req, 'support.reverse_payment', 'Payment', req.valid.params.paymentId, null, { reversalId: reversal._id, reason: req.valid.body.reason });
  res.status(201).json(reversal);
});

// ---------------------------------------------------------------- Cajas
router.patch('/cash-accounts/:cashId', validate({
  params: z.object({ id: objectId, cashId: objectId }),
  body: z.object({ name: z.string().trim().min(2).max(60).optional(), isActive: z.boolean().optional(), reason }),
}), async (req, res) => {
  const { reason: why, ...changes } = req.valid.body;
  const c = await CashAccount.findById(req.valid.params.cashId);
  if (!c) throw httpError(404, 'CASH_ACCOUNT_NOT_FOUND', 'Caja no encontrada');
  const before = pick(c, ['name', 'isActive']);
  c.set(changes);
  await c.save();
  await log(req, 'support.edit_cash', 'CashAccount', c._id, before, { ...pick(c, ['name', 'isActive']), reason: why });
  res.json(c);
});

export default router;
