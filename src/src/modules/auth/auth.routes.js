import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { REFRESH_COOKIE, refreshCookieOptions } from './tokens.js';
import {
  loginWithGoogle, startRegistration, completeRegistration, loginWithEmail,
  requestPasswordReset, resetPassword, refreshSession, logout, claimInvitations,
} from './auth.service.js';
import { Membership } from '../users/membership.model.js';
import { AllowedEmail } from './allowedEmail.model.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const send = (res, { user, accessToken, refreshToken }, status = 200) => {
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
  res.status(status).json({ accessToken, user: user.toPublic() });
};

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8, 'Mínimo 8 caracteres').max(128);

router.post('/google', limiter, validate({ body: z.object({ idToken: z.string().min(10) }) }), async (req, res) => {
  send(res, await loginWithGoogle(req.valid.body.idToken, meta(req)));
});

const code = z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos');
const codeLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

// Paso 1: envía el código al correo
router.post('/register/start', codeLimiter, validate({ body: z.object({ email }) }), async (req, res) => {
  res.json(await startRegistration(req.valid.body.email));
});

// Paso 2: valida el código, crea la contraseña e inicia sesión
router.post('/register/complete', limiter, validate({
  body: z.object({ email, code, password, name: z.string().trim().min(2).max(80) }),
}), async (req, res) => {
  send(res, await completeRegistration(req.valid.body, meta(req)), 201);
});

router.post('/password/forgot', codeLimiter, validate({ body: z.object({ email }) }), async (req, res) => {
  await requestPasswordReset(req.valid.body.email);
  res.json({ message: 'Si el correo existe, te enviamos un código' });
});

router.post('/password/reset', limiter, validate({ body: z.object({ email, code, password }) }), async (req, res) => {
  send(res, await resetPassword(req.valid.body, meta(req)));
});

router.post('/login', limiter, validate({ body: z.object({ email, password: z.string().min(1) }) }), async (req, res) => {
  send(res, await loginWithEmail(req.valid.body, meta(req)));
});

router.post('/refresh', limiter, async (req, res) => {
  send(res, await refreshSession(req.cookies?.[REFRESH_COOKIE], meta(req)));
});

router.post('/logout', async (req, res) => {
  await logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
  res.status(204).end();
});

/** Datos del usuario, sus organizaciones y si puede crear una. */
router.get('/me', authenticate, async (req, res) => {
  await claimInvitations(req.user); // invitaciones recibidas con la sesión ya abierta
  const memberships = await Membership.find({ userId: req.user._id, status: 'activa' })
    .populate('orgId', 'name slug status logoUrl currency');
  const canCreateOrg = Boolean(await AllowedEmail.exists(AllowedEmail.validFilter(req.user.email, { orgId: null, intendedRole: 'owner' })));
  res.json({
    user: req.user.toPublic(),
    canCreateOrg,
    organizations: memberships.filter((m) => m.orgId).map((m) => ({
      id: m.orgId._id, name: m.orgId.name, slug: m.orgId.slug, status: m.orgId.status,
      logoUrl: m.orgId.logoUrl, currency: m.orgId.currency, role: m.role,
    })),
  });
});

export default router;
