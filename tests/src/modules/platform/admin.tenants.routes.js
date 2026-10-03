import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { validate } from '../../middlewares/validate.js';
import { adminRole } from '../../middlewares/adminAuth.js';
import { httpError } from '../../utils/errors.js';
import { objectId, pagination } from '../../utils/schemas.js';
import { withTransaction } from '../../db/withTransaction.js';
import { sendMail } from '../../services/notifications/mailer.js';
import { welcomeOwnerEmail } from '../../services/notifications/templates.js';
import { audit } from '../audit/audit.service.js';
import { TenantAccount } from './tenantAccount.model.js';
import { Subscription } from './subscription.model.js';
import { SubscriptionPayment } from './subscriptionPayment.model.js';
import { Organization } from '../organizations/organization.model.js';
import { AllowedEmail } from '../auth/allowedEmail.model.js';
import { upsertSubscription, registerSubscriptionPayment, EXPIRED_REASON } from './subscription.service.js';

const router = Router();
const idParam = z.object({ id: objectId });
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const accountBody = z.object({
  legalName: z.string().trim().min(2).max(120),
  tradeName: z.string().trim().max(120).optional(),
  taxIdType: z.enum(['NIT', 'CC', 'CE', 'RUT', 'RFC', 'OTRO']).default('NIT'),
  taxId: z.string().trim().max(30).optional(),
  country: z.string().length(2).toUpperCase().default('CO'),
  contactName: z.string().trim().max(80).optional(),
  contactEmail: z.string().trim().toLowerCase().email(),
  contactPhone: z.string().trim().max(20).optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  source: z.string().trim().max(40).optional(),
  internalNotes: z.string().max(2000).optional(),
});

const paymentBody = z.object({
  amount: z.number().int().min(0).optional(), // por defecto: precio del plan x períodos
  method: z.enum(['transferencia', 'pasarela', 'efectivo', 'nequi', 'daviplata', 'otro']).default('transferencia'),
  reference: z.string().trim().max(80).optional(),
  periods: z.number().int().min(1).max(24).default(1),
  paidAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
});

async function loadAccount(id) {
  const account = await TenantAccount.findById(id);
  if (!account) throw httpError(404, 'TENANT_NOT_FOUND', 'Cliente no encontrado');
  return account;
}

async function sendWelcome(account, email, trialDays) {
  await sendMail({
    to: email,
    ...welcomeOwnerEmail({ companyName: account.tradeName ?? account.legalName, url: `${env.APP_URL}/login?email=${encodeURIComponent(email)}`, trialDays }),
  });
}

// ---------- listado y detalle ----------
router.get('/', validate({ query: pagination.extend({ q: z.string().trim().max(60).optional(), status: z.string().optional() }) }), async (req, res) => {
  const { q, status, page, limit } = req.valid.query;
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRx(q), 'i');
    filter.$or = [{ legalName: rx }, { tradeName: rx }, { contactEmail: rx }, { taxId: rx }];
  }
  const [items, total] = await Promise.all([
    TenantAccount.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    TenantAccount.countDocuments(filter),
  ]);
  const subs = await Subscription.find({ tenantAccountId: { $in: items.map((i) => i._id) } }).populate('planId', 'name code');
  const subBy = new Map(subs.map((s) => [String(s.tenantAccountId), s]));
  res.json({
    items: items.map((a) => ({ ...a.toJSON(), subscription: subBy.get(String(a._id)) ?? null })),
    total, page, limit,
  });
});

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  const account = await loadAccount(req.valid.params.id);
  const [subscription, payments, organizations, allowedEmails] = await Promise.all([
    Subscription.findOne({ tenantAccountId: account._id }).populate('planId'),
    SubscriptionPayment.find({ tenantAccountId: account._id }).sort({ paidAt: -1 }).limit(50).populate('registeredBy', 'name email'),
    Organization.find({ tenantAccountId: account._id }).populate('ownerUserId', 'email name lastLoginAt'),
    AllowedEmail.find({ tenantAccountId: account._id }).sort({ createdAt: -1 }).limit(50),
  ]);
  res.json({ account, subscription, payments, organizations, allowedEmails });
});

// ---------- crear y editar ----------
router.post('/', adminRole('finanzas'), validate({ body: accountBody }), async (req, res) => {
  const account = await TenantAccount.create({ ...req.valid.body, status: 'prospecto' });
  await audit(req, { action: 'tenant.create', entity: 'TenantAccount', entityId: account._id, after: account });
  res.status(201).json(account);
});

router.patch('/:id', adminRole('finanzas'), validate({ params: idParam, body: accountBody.partial() }), async (req, res) => {
  const account = await loadAccount(req.valid.params.id);
  const before = account.toObject();
  account.set(req.valid.body);
  await account.save();
  await audit(req, { action: 'tenant.update', entity: 'TenantAccount', entityId: account._id, before, after: account });
  res.json(account);
});

/**
 * Habilitar: asigna plan, registra el pago (o da días de prueba) y habilita el correo del dueño.
 * Después el cliente entra con ese correo y crea su organización.
 */
router.post('/:id/enable', adminRole('finanzas'), validate({
  params: idParam,
  body: z.object({
    planId: objectId,
    ownerEmail: z.string().trim().toLowerCase().email().optional(),
    trialDays: z.number().int().min(0).max(90).default(0),
    payment: paymentBody.optional(),
    sendEmail: z.boolean().default(true),
  }).refine((b) => b.trialDays > 0 || b.payment, { message: 'Registra un pago o da días de prueba', path: ['payment'] }),
}), async (req, res) => {
  const body = req.valid.body;
  const account = await loadAccount(req.valid.params.id);
  if (['suspendido', 'cancelado'].includes(account.status)) {
    throw httpError(409, 'TENANT_SUSPENDED', 'Reactiva el cliente antes de habilitarlo');
  }
  const ownerEmail = body.ownerEmail ?? account.contactEmail;

  const result = await withTransaction(async (session) => {
    const subscription = await upsertSubscription({ tenantAccountId: account._id, planId: body.planId, trialDays: body.payment ? 0 : body.trialDays, session });
    const payment = body.payment
      ? await registerSubscriptionPayment({ subscription, ...body.payment, adminId: req.admin._id, session })
      : null;

    await AllowedEmail.findOneAndUpdate(
      { email: ownerEmail, orgId: null },
      {
        $set: {
          tenantAccountId: account._id,
          intendedRole: 'owner',
          invitedByType: 'platform_admin',
          invitedById: req.admin._id,
          status: 'habilitado',
          expiresAt: null,
        },
      },
      { upsert: true, session },
    );

    const hasOrg = await Organization.exists({ tenantAccountId: account._id }).session(session);
    account.status = hasOrg ? 'activo' : 'habilitado';
    account.approvedBy = req.admin._id;
    account.approvedAt = new Date();
    await account.save({ session });
    return { subscription, payment };
  });

  if (body.sendEmail) await sendWelcome(account, ownerEmail, body.payment ? 0 : body.trialDays);
  await audit(req, { action: 'tenant.enable', entity: 'TenantAccount', entityId: account._id, after: { ownerEmail, planId: body.planId, trialDays: body.trialDays, payment: result.payment?._id } });
  res.json({ account, ownerEmail, ...result });
});

router.post('/:id/resend-welcome', adminRole('finanzas', 'soporte'), validate({ params: idParam }), async (req, res) => {
  const account = await loadAccount(req.valid.params.id);
  const invite = await AllowedEmail.findOne(AllowedEmail.validFilter(account.contactEmail, { orgId: null, intendedRole: 'owner' }))
    ?? await AllowedEmail.findOne({ tenantAccountId: account._id, orgId: null, intendedRole: 'owner', status: 'habilitado' });
  if (!invite) throw httpError(404, 'NO_PENDING_INVITE', 'Este cliente no tiene un correo habilitado pendiente');
  await sendWelcome(account, invite.email, 0);
  res.json({ sentTo: invite.email });
});

// ---------- pagos y plan ----------
router.post('/:id/payments', adminRole('finanzas'), validate({ params: idParam, body: paymentBody }), async (req, res) => {
  const account = await loadAccount(req.valid.params.id);
  const payment = await withTransaction(async (session) => {
    const subscription = await Subscription.findOne({ tenantAccountId: account._id }).session(session);
    if (!subscription) throw httpError(409, 'NO_SUBSCRIPTION', 'Primero habilita el cliente con un plan');
    return registerSubscriptionPayment({ subscription, ...req.valid.body, adminId: req.admin._id, session });
  });
  await audit(req, { action: 'tenant.payment', entity: 'SubscriptionPayment', entityId: payment._id, after: payment });
  res.status(201).json(payment);
});

router.post('/:id/plan', adminRole('finanzas'), validate({ params: idParam, body: z.object({ planId: objectId }) }), async (req, res) => {
  const account = await loadAccount(req.valid.params.id);
  const subscription = await withTransaction((session) => upsertSubscription({ tenantAccountId: account._id, planId: req.valid.body.planId, session }));
  await audit(req, { action: 'tenant.plan_change', entity: 'Subscription', entityId: subscription._id, after: { planId: req.valid.body.planId } });
  res.json(subscription);
});

// ---------- suspender y reactivar ----------
router.post('/:id/suspend', adminRole('finanzas'), validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5).max(300) }) }), async (req, res) => {
  const account = await loadAccount(req.valid.params.id);
  const { reason } = req.valid.body;
  await withTransaction(async (session) => {
    account.status = 'suspendido';
    await account.save({ session });
    await Organization.updateMany(
      { tenantAccountId: account._id, status: { $ne: 'archivada' } },
      { $set: { status: 'suspendida', statusReason: reason, statusChangedAt: new Date() } },
      { session },
    );
  });
  await audit(req, { action: 'tenant.suspend', entity: 'TenantAccount', entityId: account._id, after: { reason } });
  res.json(account);
});

router.post('/:id/reactivate', adminRole('finanzas'), validate({ params: idParam }), async (req, res) => {
  const account = await loadAccount(req.valid.params.id);
  await withTransaction(async (session) => {
    const sub = await Subscription.findOne({ tenantAccountId: account._id }).session(session);
    const paid = sub && ['prueba', 'activa', 'en_gracia'].includes(sub.status);
    const hasOrg = await Organization.exists({ tenantAccountId: account._id }).session(session);
    account.status = hasOrg ? 'activo' : 'habilitado';
    await account.save({ session });
    await Organization.updateMany(
      { tenantAccountId: account._id, status: 'suspendida' },
      paid
        ? { $set: { status: 'activa', statusReason: null, statusChangedAt: new Date() } }
        : { $set: { status: 'solo_lectura', statusReason: EXPIRED_REASON, statusChangedAt: new Date() } },
      { session },
    );
  });
  await audit(req, { action: 'tenant.reactivate', entity: 'TenantAccount', entityId: account._id });
  res.json(account);
});

// ---------- correos habilitados ----------
router.delete('/:id/allowed-emails/:emailId', adminRole('finanzas', 'soporte'), validate({ params: idParam.extend({ emailId: objectId }) }), async (req, res) => {
  const invite = await AllowedEmail.findOne({ _id: req.valid.params.emailId, tenantAccountId: req.valid.params.id });
  if (!invite) throw httpError(404, 'INVITATION_NOT_FOUND', 'Correo no encontrado');
  invite.status = 'revocado';
  await invite.save();
  await audit(req, { action: 'tenant.revoke_email', entity: 'AllowedEmail', entityId: invite._id, after: { email: invite.email } });
  res.status(204).end();
});

export default router;
