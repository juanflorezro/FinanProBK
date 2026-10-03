import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { sendMail } from '../../services/notifications/mailer.js';
import { invitationEmail } from '../../services/notifications/templates.js';
import { Membership } from './membership.model.js';
import { AllowedEmail } from '../auth/allowedEmail.model.js';
import { User } from '../auth/user.model.js';

const router = Router();
const INVITE_DAYS = 7;
const INVITABLE = ['admin', 'analista', 'cobrador', 'auditor'];
const RANK = { owner: 3, admin: 2, analista: 1, cobrador: 1, auditor: 1 };

/** Solo se gestiona a quien tiene un rango menor: el dueño maneja admins, el admin al resto. */
function assertCanManage(actorRole, targetRole) {
  if ((RANK[actorRole] ?? 0) <= (RANK[targetRole] ?? 0)) {
    throw httpError(403, 'ROLE_NOT_ALLOWED', `Tu rol no puede gestionar el rol ${targetRole}`);
  }
}

async function sendInvitation(req, invite) {
  const url = `${env.APP_URL}/login?invite=${req.org.slug}&email=${encodeURIComponent(invite.email)}`;
  await sendMail({
    to: invite.email,
    ...invitationEmail({
      orgName: req.org.name,
      inviterName: req.user.name ?? req.user.email,
      role: invite.intendedRole,
      url,
      expiresAt: invite.expiresAt,
    }),
  });
}

// Equipo actual + invitaciones pendientes
router.get('/', can('member.read'), async (req, res) => {
  const orgId = req.org._id;
  const [members, invitations] = await Promise.all([
    Membership.find({ orgId }).populate('userId', 'email name avatarUrl lastLoginAt').sort({ joinedAt: 1 }),
    AllowedEmail.find({ orgId, status: 'habilitado' }).sort({ createdAt: -1 }),
  ]);
  res.json({
    members: members.map((m) => ({
      id: m._id, role: m.role, status: m.status, joinedAt: m.joinedAt,
      user: m.userId && { id: m.userId._id, email: m.userId.email, name: m.userId.name, avatarUrl: m.userId.avatarUrl, lastLoginAt: m.userId.lastLoginAt },
      isYou: m.userId?._id.equals(req.user._id),
    })),
    invitations: invitations.map((i) => ({
      id: i._id, email: i.email, role: i.intendedRole, expiresAt: i.expiresAt,
      expired: i.expiresAt && i.expiresAt < new Date(),
    })),
  });
});

// Invitar (o reenviar con nuevo rol/vencimiento si ya existía)
router.post('/invitations', can('member.create'), validate({
  body: z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(INVITABLE) }),
}), async (req, res) => {
  const { email, role } = req.valid.body;
  const orgId = req.org._id;
  assertCanManage(req.membership.role, role);

  const existingUser = await User.findOne({ email });
  if (existingUser && await Membership.exists({ orgId, userId: existingUser._id })) {
    throw httpError(409, 'ALREADY_MEMBER', 'Esa persona ya es parte del equipo');
  }

  const invite = await AllowedEmail.findOneAndUpdate(
    { email, orgId },
    {
      $set: {
        tenantAccountId: req.org.tenantAccountId,
        intendedRole: role,
        invitedByType: 'user',
        invitedById: req.user._id,
        status: 'habilitado',
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
        usedAt: null,
        usedByUserId: null,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  await sendInvitation(req, invite);
  res.status(201).json({ id: invite._id, email, role, expiresAt: invite.expiresAt });
});

router.post('/invitations/:id/resend', can('member.create'), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const invite = await AllowedEmail.findOne({ _id: req.valid.params.id, orgId: req.org._id, status: 'habilitado' });
  if (!invite) throw httpError(404, 'INVITATION_NOT_FOUND', 'Invitación no encontrada');
  assertCanManage(req.membership.role, invite.intendedRole);
  invite.expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await invite.save();
  await sendInvitation(req, invite);
  res.json({ id: invite._id, expiresAt: invite.expiresAt });
});

router.delete('/invitations/:id', can('member.delete'), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const invite = await AllowedEmail.findOne({ _id: req.valid.params.id, orgId: req.org._id, status: 'habilitado' });
  if (!invite) throw httpError(404, 'INVITATION_NOT_FOUND', 'Invitación no encontrada');
  assertCanManage(req.membership.role, invite.intendedRole);
  invite.status = 'revocado';
  await invite.save();
  res.status(204).end();
});

// Cambiar rol o suspender/reactivar a un miembro
router.patch('/:id', can('member.update'), validate({
  params: z.object({ id: objectId }),
  body: z.object({ role: z.enum(INVITABLE).optional(), status: z.enum(['activa', 'suspendida']).optional() })
    .refine((b) => b.role || b.status, 'Indica role o status'),
}), async (req, res) => {
  const member = await Membership.findOne({ _id: req.valid.params.id, orgId: req.org._id });
  if (!member) throw httpError(404, 'MEMBER_NOT_FOUND', 'Miembro no encontrado');
  if (member.userId.equals(req.user._id)) throw httpError(400, 'CANNOT_EDIT_SELF', 'No puedes cambiar tu propio rol o estado');
  assertCanManage(req.membership.role, member.role);
  if (req.valid.body.role) assertCanManage(req.membership.role, req.valid.body.role);

  member.set(req.valid.body);
  await member.save();
  res.json({ id: member._id, role: member.role, status: member.status });
});

export default router;
