import { Router } from 'express';
import { z } from 'zod';
import dayjs from 'dayjs';
import { validate } from '../../middlewares/validate.js';
import { adminRole } from '../../middlewares/adminAuth.js';
import { httpError } from '../../utils/errors.js';
import { objectId, pagination } from '../../utils/schemas.js';
import { runWithContext } from '../../db/context.js';
import { audit } from '../audit/audit.service.js';
import { Organization, ORG_STATUS } from '../organizations/organization.model.js';
import { Membership } from '../users/membership.model.js';
import { Subscription } from './subscription.model.js';
import { SupportGrant } from './supportGrant.model.js';
import { Borrower } from '../borrowers/borrower.model.js';
import { Loan, LOAN_STATUS } from '../loans/loan.model.js';
import { Payment } from '../payments/payment.model.js';
import { PaymentAllocation } from '../payments/paymentAllocation.model.js';
import { getInstallments, refreshLoan } from '../loans/loan.service.js';

const router = Router();
const idParam = z.object({ id: objectId });
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function loadOrg(id) {
  const org = await Organization.findById(id);
  if (!org) throw httpError(404, 'ORG_NOT_FOUND', 'Organización no encontrada');
  return org;
}

/** Ejecuta consultas de datos de la organización (deudores, préstamos...) dentro de su contexto. */
const inOrg = (orgId, fn, extra = {}) => runWithContext({ orgId, userId: null, ...extra }, fn);

// ---------- listado y detalle ----------
router.get('/', validate({ query: pagination.extend({ q: z.string().trim().max(60).optional(), status: z.enum(ORG_STATUS).optional() }) }), async (req, res) => {
  const { q, status, page, limit } = req.valid.query;
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRx(q), 'i');
    filter.$or = [{ name: rx }, { legalName: rx }, { slug: rx }, { taxId: rx }];
  }
  const [items, total] = await Promise.all([
    Organization.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('ownerUserId', 'email name lastLoginAt')
      .populate('tenantAccountId', 'legalName status'),
    Organization.countDocuments(filter),
  ]);
  const subs = await Subscription.find({ orgId: { $in: items.map((o) => o._id) } }).populate('planId', 'name code');
  const subBy = new Map(subs.map((s) => [String(s.orgId), s]));
  res.json({ items: items.map((o) => ({ ...o.toJSON(), subscription: subBy.get(String(o._id)) ?? null })), total, page, limit });
});

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  const org = await loadOrg(req.valid.params.id);
  const since = dayjs().subtract(30, 'day').toDate();

  const [members, subscription, activeGrant] = await Promise.all([
    Membership.find({ orgId: org._id }).populate('userId', 'email name lastLoginAt status'),
    Subscription.findOne({ orgId: org._id }).populate('planId'),
    SupportGrant.activeFor(org._id, req.admin._id),
  ]);

  // Solo números agregados: el detalle de deudores y préstamos requiere acceso de soporte
  const stats = await inOrg(org._id, async () => {
    const [borrowers, loansByStatus, payments30d, lastPayment] = await Promise.all([
      Borrower.countDocuments({}),
      Loan.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, balance: { $sum: '$balancePrincipal' } } }]),
      Payment.aggregate([
        { $match: { paidAt: { $gte: since }, status: 'aplicado', isReversal: false } },
        { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$amount' } } },
      ]),
      Payment.findOne({}).sort({ paidAt: -1 }).select('paidAt'),
    ]);
    return {
      borrowers,
      loansByStatus: Object.fromEntries(loansByStatus.map((r) => [r._id, { count: r.n, balancePrincipal: r.balance }])),
      payments30d: payments30d[0] ? { count: payments30d[0].n, total: payments30d[0].total } : { count: 0, total: 0 },
      lastPaymentAt: lastPayment?.paidAt ?? null,
    };
  });

  res.json({ organization: org, subscription, members, stats, supportAccess: activeGrant });
});

router.patch('/:id/status', adminRole('soporte', 'finanzas'), validate({
  params: idParam,
  body: z.object({ status: z.enum(ORG_STATUS), reason: z.string().trim().min(5).max(300) }),
}), async (req, res) => {
  const org = await loadOrg(req.valid.params.id);
  const before = { status: org.status, statusReason: org.statusReason };
  org.status = req.valid.body.status;
  org.statusReason = req.valid.body.reason;
  org.statusChangedAt = new Date();
  await org.save();
  await audit(req, { action: 'org.status', entity: 'Organization', entityId: org._id, orgId: org._id, before, after: { status: org.status, statusReason: org.statusReason } });
  res.json(org);
});

// ---------- acceso de soporte ----------
router.post('/:id/support-access', adminRole('soporte'), validate({
  params: idParam,
  body: z.object({
    reason: z.string().trim().min(10).max(500),
    scope: z.enum(['lectura', 'escritura']).default('lectura'),
    minutes: z.number().int().min(15).max(480).default(60),
    ticketRef: z.string().trim().max(60).optional(),
  }),
}), async (req, res) => {
  const org = await loadOrg(req.valid.params.id);
  const { minutes, ...rest } = req.valid.body;
  await SupportGrant.updateMany({ orgId: org._id, adminId: req.admin._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  const grant = await SupportGrant.create({ ...rest, orgId: org._id, adminId: req.admin._id, expiresAt: new Date(Date.now() + minutes * 60_000) });
  await audit(req, { action: 'support.grant', entity: 'SupportGrant', entityId: grant._id, orgId: org._id, supportGrantId: grant._id, after: grant });
  res.status(201).json(grant);
});

router.delete('/:id/support-access', adminRole('soporte'), validate({ params: idParam }), async (req, res) => {
  await SupportGrant.updateMany({ orgId: req.valid.params.id, adminId: req.admin._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(req, { action: 'support.revoke', entity: 'Organization', entityId: req.valid.params.id, orgId: req.valid.params.id });
  res.status(204).end();
});

/** Exige acceso de soporte vigente y corre la ruta dentro del contexto de la organización. */
const requireSupport = (scope = 'lectura') => async (req, _res, next) => {
  const grant = await SupportGrant.activeFor(req.params.id, req.admin._id);
  if (!grant) return next(httpError(403, 'SUPPORT_ACCESS_REQUIRED', 'Solicita acceso de soporte para ver datos de esta organización'));
  if (scope === 'escritura' && grant.scope !== 'escritura') {
    return next(httpError(403, 'SUPPORT_WRITE_REQUIRED', 'Tu acceso de soporte es solo de lectura'));
  }
  req.supportGrant = grant;
  inOrg(grant.orgId, () => next(), { supportGrantId: grant._id });
};

const support = Router({ mergeParams: true });

support.get('/borrowers', requireSupport(), validate({ query: pagination.extend({ q: z.string().trim().max(60).optional() }) }), async (req, res) => {
  const { q, page, limit } = req.valid.query;
  const filter = q ? { $or: [{ docNumber: new RegExp(escapeRx(q), 'i') }, { lastName: new RegExp(escapeRx(q), 'i') }, { firstName: new RegExp(escapeRx(q), 'i') }] } : {};
  const [items, total] = await Promise.all([
    Borrower.find(filter).sort({ lastName: 1 }).skip((page - 1) * limit).limit(limit),
    Borrower.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});

support.get('/loans', requireSupport(), validate({ query: pagination.extend({ status: z.enum(LOAN_STATUS).optional(), borrowerId: objectId.optional() }) }), async (req, res) => {
  const { page, limit, ...rest } = req.valid.query;
  const filter = Object.fromEntries(Object.entries(rest).filter(([, v]) => v));
  const [items, total] = await Promise.all([
    Loan.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('borrowerId', 'code firstName lastName docNumber'),
    Loan.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});

support.get('/loans/:loanId', requireSupport(), validate({ params: z.object({ id: objectId, loanId: objectId }) }), async (req, res) => {
  const loan = await Loan.findById(req.valid.params.loanId).populate('borrowerId', 'code firstName lastName docType docNumber phone');
  if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
  const [installments, payments] = await Promise.all([
    getInstallments(loan),
    Payment.find({ loanId: loan._id }).sort({ paidAt: -1 }),
  ]);
  const allocations = await PaymentAllocation.find({ paymentId: { $in: payments.map((p) => p._id) } }).sort({ order: 1 });
  await audit(req, { action: 'support.view_loan', entity: 'Loan', entityId: loan._id, orgId: loan.orgId, supportGrantId: req.supportGrant._id });
  res.json({ loan, installments, payments, allocations });
});

support.post('/loans/:loanId/refresh', requireSupport('escritura'), validate({ params: z.object({ id: objectId, loanId: objectId }) }), async (req, res) => {
  const loan = await refreshLoan(req.valid.params.loanId);
  await audit(req, { action: 'support.refresh_loan', entity: 'Loan', entityId: req.valid.params.loanId, orgId: req.supportGrant.orgId, supportGrantId: req.supportGrant._id });
  res.json(loan);
});

router.use('/:id/support', adminRole('soporte'), support);

export default router;
