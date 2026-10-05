import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { REFRESH_COOKIE, refreshCookieOptions, TRUSTED_COOKIE, trustedCookieOptions, signTrustedDevice } from './tokens.js';
import {
  loginWithGoogle, startRegistration, completeRegistration, loginWithEmail,
  requestPasswordReset, resetPassword, refreshSession, logout, claimInvitations,
  completeLoginMfa, resendLoginCode,
} from './auth.service.js';
import { startTotpSetup, enableTotp, disableTotp, regenerateBackupCodes } from './mfa.service.js';
import { Membership } from '../users/membership.model.js';
import { AllowedEmail } from './allowedEmail.model.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const send = (res, result, status = 200, { trust = false } = {}) => {
  if (result.mfaRequired) return res.status(200).json(result); // falta el segundo factor
  const { user, accessToken, refreshToken } = result;
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
  if (trust) res.cookie(TRUSTED_COOKIE, signTrustedDevice(user), trustedCookieOptions()); // este equipo queda de confianza
  // Respaldo cuando el navegador bloquea la cookie (Safari, bloqueo de terceros): la app guarda el
  // refresh token y lo envía en el cuerpo. Solo si lo pide con X-Session-Mode: token.
  const tokenMode = res.req?.get?.('x-session-mode') === 'token';
  res.status(status).json({ accessToken, user: user.toPublic(), ...(tokenMode && { refreshToken }) });
};
const trusted = (req) => ({ trustedDevice: req.cookies?.[TRUSTED_COOKIE] });

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8, 'Mínimo 8 caracteres').max(128);

router.post('/google', limiter, validate({ body: z.object({ idToken: z.string().min(10) }) }), async (req, res) => {
  send(res, await loginWithGoogle(req.valid.body.idToken, meta(req), trusted(req)), 200, { trust: true });
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
  send(res, await completeRegistration(req.valid.body, meta(req)), 201, { trust: true });
});

router.post('/password/forgot', codeLimiter, validate({ body: z.object({ email }) }), async (req, res) => {
  await requestPasswordReset(req.valid.body.email);
  res.json({ message: 'Si el correo existe, te enviamos un código' });
});

router.post('/password/reset', limiter, validate({ body: z.object({ email, code, password }) }), async (req, res) => {
  await resetPassword(req.valid.body);
  res.json({ message: 'Contraseña actualizada. Inicia sesión con la nueva.' });
});

// Paso 1: contraseña → responde { mfaRequired, method: 'email' | 'totp', mfaToken }
router.post('/login', limiter, validate({ body: z.object({ email, password: z.string().min(1) }) }), async (req, res) => {
  send(res, await loginWithEmail(req.valid.body, meta(req), trusted(req)), 200, { trust: true });
});

// Paso 2: código del correo, de la app o de respaldo
const mfaToken = z.string().min(20);
router.post('/login/verify', limiter, validate({
  body: z.object({ mfaToken, code: z.string().trim().min(6).max(12) }),
}), async (req, res) => {
  send(res, await completeLoginMfa(req.valid.body, meta(req)), 200, { trust: true });
});

router.post('/login/resend', codeLimiter, validate({ body: z.object({ mfaToken }) }), async (req, res) => {
  res.json(await resendLoginCode(req.valid.body.mfaToken));
});

// ---------- App de autenticación (Google Authenticator, Microsoft Authenticator, Authy) ----------
const totpCode = z.object({ code: z.string().trim().min(6).max(12) });

router.post('/mfa/totp/setup', authenticate, async (req, res) => {
  res.json(await startTotpSetup(req.user._id));
});

router.post('/mfa/totp/enable', authenticate, limiter, validate({ body: totpCode }), async (req, res) => {
  res.json(await enableTotp(req.user._id, req.valid.body.code));
});

router.post('/mfa/totp/disable', authenticate, limiter, validate({ body: totpCode }), async (req, res) => {
  await disableTotp(req.user._id, req.valid.body.code);
  res.status(204).end();
});

router.post('/mfa/backup-codes', authenticate, limiter, validate({ body: totpCode }), async (req, res) => {
  res.json(await regenerateBackupCodes(req.user._id, req.valid.body.code));
});

router.post('/refresh', limiter, async (req, res) => {
  send(res, await refreshSession(req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken, meta(req)));
});

router.post('/logout', async (req, res) => {
  await logout(req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken);
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
