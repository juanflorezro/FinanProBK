import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { httpError } from '../../utils/errors.js';
import { objectId, pagination, cents } from '../../utils/schemas.js';
import { CashAccount } from '../cash/cashAccount.model.js';
import { Payment, PAYMENT_METHODS } from './payment.model.js';
import { PaymentAllocation } from './paymentAllocation.model.js';
import { registerPayment, reversePayment } from './payment.service.js';

const router = Router();

const createBody = z.object({
  loanId: objectId,
  amount: cents,
  method: z.enum(PAYMENT_METHODS),
  cashAccountId: objectId,
  channel: z.enum(['oficina', 'cobrador', 'portal']).default('oficina'),
  paidAt: z.coerce.date().optional(),
  valueDate: z.coerce.date().optional(),
  externalReference: z.string().trim().max(80).optional(),
  excessMode: z.enum(['proximas_cuotas', 'capital']).optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

/** Header Idempotency-Key (o idempotencyKey en el body) evita pagos duplicados por doble clic. */
router.post('/', can('payment.create'), validate({ body: createBody }), async (req, res) => {
  const body = req.valid.body;
  const idempotencyKey = req.get('idempotency-key') ?? body.idempotencyKey;
  if (!idempotencyKey) throw httpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Envía el header Idempotency-Key');

  const cash = await CashAccount.findById(body.cashAccountId);
  if (!cash?.isActive) throw httpError(404, 'CASH_ACCOUNT_NOT_FOUND', 'Caja no encontrada o inactiva');

  const payment = await registerPayment(
    { ...body, idempotencyKey },
    { waterfall: req.org.settings.paymentWaterfall, excessMode: body.excessMode },
  );
  res.status(201).json(payment);
});

router.get('/', can('payment.read'), validate({
  query: pagination.extend({
    loanId: objectId.optional(),
    borrowerId: objectId.optional(),
    cashAccountId: objectId.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
}), async (req, res) => {
  const { page, limit, from, to, ...rest } = req.valid.query;
  const filter = Object.fromEntries(Object.entries(rest).filter(([, v]) => v));
  if (from || to) filter.paidAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ paidAt: -1 }).skip((page - 1) * limit).limit(limit),
    Payment.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});

router.get('/:id', can('payment.read'), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const payment = await Payment.findById(req.valid.params.id);
  if (!payment) throw httpError(404, 'PAYMENT_NOT_FOUND', 'Pago no encontrado');
  const allocations = await PaymentAllocation.find({ paymentId: payment._id }).sort({ order: 1 });
  res.json({ payment, allocations });
});

router.post('/:id/reverse', can('payment.reverse'), validate({
  params: z.object({ id: objectId }),
  body: z.object({ reason: z.string().trim().min(5).max(300) }),
}), async (req, res) => {
  res.status(201).json(await reversePayment(req.valid.params.id, req.valid.body.reason));
});

export default router;
