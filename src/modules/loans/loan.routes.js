import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { httpError } from '../../utils/errors.js';
import { objectId, pagination, cents, rateValue } from '../../utils/schemas.js';
import { RATE_BASES, FREQUENCIES } from '../../utils/rates.js';
import { nextSeq } from '../counters/counter.model.js';
import { Borrower } from '../borrowers/borrower.model.js';
import { Loan, LOAN_STATUS, AMORTIZATION } from './loan.model.js';
import { Payment } from '../payments/payment.model.js';
import { disburseLoan, refreshLoan, getInstallments } from './loan.service.js';
import { assertPlanLimit } from '../../utils/planLimits.js';
import { checkRateCompliance } from './rateCompliance.js';
import { loanQuery, buildLoanFilter } from '../../utils/listFilters.js';
import { buildSchedule } from './schedule.js';
import { deriveRates } from '../../utils/rates.js';
import { addPeriods } from '../../utils/dates.js';

const router = Router();
const idParam = { params: z.object({ id: objectId }) };

const createBody = z.object({
  borrowerId: objectId,
  productId: objectId.optional(),
  collectorId: objectId.optional(),
  lendingRegime: z.enum(['formal', 'informal']).default('formal'),
  principal: cents,
  rate: rateValue,
  rateBasis: z.enum(RATE_BASES).default('mensual'),
  rateKind: z.enum(['nominal', 'efectiva']).default('efectiva'),
  interestBase: z.enum(['saldo_capital', 'capital_inicial']).default('saldo_capital'),
  lateRate: rateValue.default('0'),
  lateRateBasis: z.enum(RATE_BASES).default('mensual'),
  lateInterestBase: z.enum(['capital', 'capital_e_interes']).default('capital'),
  amortization: z.enum(AMORTIZATION).default('frances'),
  frequency: z.enum(FREQUENCIES).default('mensual'),
  termCount: z.number().int().min(1).max(600).optional(),
  graceDays: z.number().int().min(0).max(90).default(0),
  notes: z.string().max(1000).optional(),
  acknowledgeRateCap: z.boolean().optional(), // confirma tasa sobre el tope (política 'advertir')
}).refine((b) => b.amortization === 'abonos_libres' || b.termCount, {
  path: ['termCount'], message: 'Indica el número de cuotas',
});

/** Calcula el plan de cuotas y revisa la tasa sin guardar nada. Para la vista previa del formulario. */
router.post('/simulate', can('loan.create'), validate({
  body: z.object({
    principal: cents,
    rate: rateValue,
    rateBasis: z.enum(RATE_BASES).default('mensual'),
    rateKind: z.enum(['nominal', 'efectiva']).default('efectiva'),
    interestBase: z.enum(['saldo_capital', 'capital_inicial']).default('saldo_capital'),
    amortization: z.enum(AMORTIZATION).default('frances'),
    frequency: z.enum(FREQUENCIES).default('mensual'),
    termCount: z.number().int().min(1).max(600).optional(),
    firstDueDate: z.coerce.date().optional(),
  }).refine((b) => b.amortization === 'abonos_libres' || b.termCount, { path: ['termCount'], message: 'Indica el número de cuotas' }),
}), async (req, res) => {
  const b = req.valid.body;
  const rates = deriveRates(b);
  const schedule = buildSchedule({
    ...b,
    ratePerPeriod: rates.ratePerPeriod,
    firstDueDate: b.firstDueDate ?? addPeriods(new Date(), b.frequency, 1),
  });
  let compliance;
  try {
    compliance = { ...(await checkRateCompliance({ org: req.org, loan: b, acknowledge: true })), ok: true };
  } catch (err) {
    compliance = { ok: false, code: err.code, message: err.message, details: err.details };
  }
  if (compliance.rateCapCheck === 'excede_confirmado') {
    compliance = { ok: false, code: 'RATE_CAP_ACK_REQUIRED', policy: 'advertir', message: 'La tasa supera el máximo legal. Tendrás que confirmar el aviso al crear el préstamo.', maxAnnual: compliance.rateCapEA };
  }
  const totals = schedule.reduce((a, r) => ({ principal: a.principal + r.principalDue, interest: a.interest + r.interestDue }), { principal: 0, interest: 0 });
  res.json({ rates, schedule, totals: { ...totals, total: totals.principal + totals.interest }, compliance });
});

router.post('/', can('loan.create'), validate({ body: createBody }), async (req, res) => {
  const { acknowledgeRateCap, ...body } = req.valid.body;
  const borrower = await Borrower.findById(body.borrowerId);
  if (!borrower) throw httpError(404, 'BORROWER_NOT_FOUND', 'Deudor no encontrado');
  if (borrower.status === 'bloqueado') throw httpError(409, 'BORROWER_BLOCKED', 'El deudor está bloqueado');
  if (!req.org.settings.allowedRegimes.includes(body.lendingRegime)) {
    throw httpError(400, 'REGIME_NOT_ALLOWED', `La organización no permite préstamos ${body.lendingRegime}`);
  }

  await assertPlanLimit(req.org, 'maxActiveLoans');
  const compliance = await checkRateCompliance({ org: req.org, loan: body, acknowledge: acknowledgeRateCap, membershipId: req.membership._id });
  const seq = await nextSeq(req.org._id, 'loan');
  const loan = await Loan.create({
    ...body,
    loanNumber: `${req.org.settings.loanPrefix}${seq}`,
    currency: req.org.currency,
    officerId: req.membership._id,
    collectorId: body.collectorId ?? borrower.assignedCollectorId,
    graceDays: body.graceDays || req.org.settings.graceDays,
    rateSource: body.productId ? 'producto' : 'manual',
    ...compliance,
  });
  res.status(201).json(loan);
});

router.get('/', can('loan.read'), validate({ query: pagination.merge(loanQuery) }), async (req, res) => {
  const { page, limit, ...f } = req.valid.query;
  const { filter, sort } = await buildLoanFilter(f);
  const [items, total] = await Promise.all([
    Loan.find(filter).sort(sort).skip((page - 1) * limit).limit(limit)
      .populate('borrowerId', 'code firstName lastName docType docNumber phone'),
    Loan.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});

router.get('/:id', can('loan.read'), validate(idParam), async (req, res) => {
  const loan = await Loan.findById(req.valid.params.id).populate('borrowerId', 'code firstName lastName docType docNumber phone');
  if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
  const [installments, payments] = await Promise.all([
    getInstallments(loan),
    Payment.find({ loanId: loan._id }).sort({ paidAt: -1 }).limit(100),
  ]);
  res.json({ loan, installments, payments });
});

router.post('/:id/disburse', can('loan.disburse'), validate({
  ...idParam,
  body: z.object({ disbursementDate: z.coerce.date().optional(), firstDueDate: z.coerce.date().optional() }),
}), async (req, res) => {
  res.json(await disburseLoan(req.valid.params.id, req.valid.body));
});

router.post('/:id/refresh', can('loan.read'), validate(idParam), async (req, res) => {
  res.json(await refreshLoan(req.valid.params.id));
});

export default router;
