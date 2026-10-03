import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { withTransaction } from '../../db/withTransaction.js';
import { httpError } from '../../utils/errors.js';
import { slugify, randomToken } from '../../utils/crypto.js';
import { Organization } from './organization.model.js';
import { Membership } from '../users/membership.model.js';
import { AllowedEmail } from '../auth/allowedEmail.model.js';
import { TenantAccount } from '../platform/tenantAccount.model.js';
import { Subscription } from '../platform/subscription.model.js';
import { EXPIRED_REASON } from '../platform/subscription.service.js';

const router = Router();

const createBody = z.object({
  name: z.string().trim().min(2).max(80),
  legalName: z.string().trim().max(120).optional(),
  taxId: z.string().trim().max(30).optional(),
  country: z.string().length(2).toUpperCase().default('CO'),
  currency: z.string().length(3).toUpperCase().default('COP'),
  timezone: z.string().default('America/Bogota'),
});

/** El dueño habilitado crea su organización en el primer ingreso. */
router.post('/', validate({ body: createBody }), async (req, res) => {
  const user = req.user;
  const invitation = await AllowedEmail.findOne(AllowedEmail.validFilter(user.email, { orgId: null, intendedRole: 'owner' }));
  if (!invitation) throw httpError(403, 'NO_OWNER_INVITATION', 'Tu correo no está habilitado para crear una organización');

  const org = await withTransaction(async (session) => {
    const sub = invitation.tenantAccountId
      ? await Subscription.findOne({ tenantAccountId: invitation.tenantAccountId }).session(session)
      : null;
    const readOnly = sub && !['prueba', 'activa', 'en_gracia'].includes(sub.status);
    const [created] = await Organization.create([{
      ...req.valid.body,
      ...(readOnly && { status: 'solo_lectura', statusReason: EXPIRED_REASON, statusChangedAt: new Date() }),
      tenantAccountId: invitation.tenantAccountId,
      ownerUserId: user._id,
      slug: `${slugify(req.valid.body.name) || 'org'}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    }], { session, ordered: true });

    await Membership.create([{ orgId: created._id, userId: user._id, role: 'owner', status: 'activa' }], { session, ordered: true });
    if (sub && !sub.orgId) {
      sub.orgId = created._id;
      await sub.save({ session });
    }

    invitation.status = 'usado';
    invitation.usedAt = new Date();
    invitation.usedByUserId = user._id;
    await invitation.save({ session });

    if (invitation.tenantAccountId) {
      await TenantAccount.updateOne({ _id: invitation.tenantAccountId }, { $set: { status: 'activo' } }, { session });
    }
    user.defaultOrgId = created._id;
    await user.save({ session });
    return created;
  });

  res.status(201).json(org);
});

export default router;
