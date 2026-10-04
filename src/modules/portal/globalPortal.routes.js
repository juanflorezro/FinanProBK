import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';
import { validate } from '../../middlewares/validate.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { maskEmail } from '../../utils/crypto.js';
import { runWithContext } from '../../db/context.js';
import { Organization } from '../organizations/organization.model.js';
import { Borrower } from '../borrowers/borrower.model.js';
import { Loan } from '../loans/loan.model.js';
import { AuditLog } from '../audit/auditLog.model.js';
import { PortalChallenge } from './portalChallenge.model.js';
import { newPortalChallenge, sameCode } from './portal.codes.js';
import { VISIBLE, LOAN_SUMMARY, loanDetail, sendPortalCodeMail } from './portal.shared.js';

/**
 * Portal GLOBAL del deudor (/api/portal-global): entra una sola vez con su correo
 * (Google o código) y ve todos sus préstamos en todas las empresas de FinanPro.
 * Solo aparecen las empresas activas con el portal habilitado.
 */
const router = Router();
const CODE_MIN = 10;
const SESSION = '30m';
const AUD = 'portal-global';
const google = new OAuth2Client(env.GOOGLE_CLIENT_ID);
const limiter = (limit) => rateLimit({ windowMs: 15 * 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'TOO_MANY', message: 'Demasiados intentos. Espera unos minutos.' } });

const emailSchema = z.string().trim().toLowerCase().email('Escribe un correo válido');
const NOT_FOUND = (email) => httpError(404, 'EMAIL_NOT_REGISTERED', `El correo ${email} no está registrado en ninguna empresa. Pide a quien te prestó que registre tu correo en tu ficha.`);

/** Fichas del deudor (una por empresa) en empresas activas con portal habilitado. */
async function profilesFor(email) {
  const borrowers = await Borrower.find({ email, status: { $ne: 'bloqueado' } })
    .setOptions({ skipTenant: true }).select('orgId firstName lastName docType docNumber').lean();
  if (!borrowers.length) return [];
  const orgs = await Organization.find({
    _id: { $in: borrowers.map((b) => b.orgId) },
    status: { $in: ['activa', 'solo_lectura'] },
    'settings.portalEnabled': { $ne: false },
  }).select('name slug logoUrl currency').lean();
  const byId = new Map(orgs.map((o) => [String(o._id), o]));
  return borrowers.filter((b) => byId.has(String(b.orgId))).map((b) => ({ borrower: b, org: byId.get(String(b.orgId)) }));
}

const sign = (email) => jwt.sign({ sub: email }, env.JWT_ACCESS_SECRET, { audience: AUD, expiresIn: SESSION });

function requireSession(req, _res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  try {
    req.portalEmail = jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: AUD }).sub;
    next();
  } catch {
    next(httpError(401, 'PORTAL_SESSION_EXPIRED', 'Tu sesión terminó. Ingresa de nuevo.'));
  }
}

// ---------------------------------------------------------------- Código al correo
router.post('/request-code', limiter(8), validate({ body: z.object({ email: emailSchema }) }), async (req, res) => {
  const { email } = req.valid.body;
  const profiles = await profilesFor(email);
  if (!profiles.length) throw NOT_FOUND(email);
  if (await PortalChallenge.exists({ email, createdAt: { $gt: new Date(Date.now() - 60_000) } })) {
    throw httpError(429, 'CODE_COOLDOWN', 'Ya te enviamos un código. Espera un minuto para pedir otro.');
  }
  const { challenge, code } = newPortalChallenge({ channel: 'email', minutes: CODE_MIN, ip: req.ip });
  challenge.email = email;
  await sendPortalCodeMail({ to: email, firstName: profiles[0].borrower.firstName, code, minutes: CODE_MIN, issuer: 'FinanPro' });
  await challenge.save();
  res.json({ challengeId: challenge._id, expiresInMinutes: CODE_MIN, sentTo: maskEmail(email) });
});

router.post('/verify', limiter(20), validate({
  body: z.object({ challengeId: objectId, code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos') }),
}), async (req, res) => {
  const { challengeId, code } = req.valid.body;
  const ch = await PortalChallenge.findOne({ _id: challengeId, email: { $exists: true } });
  const invalid = httpError(400, 'CODE_INVALID', 'Código incorrecto o vencido');
  if (!ch || ch.verifiedAt || ch.expiresAt < new Date()) throw invalid;
  if (ch.attempts >= 5) throw httpError(429, 'CODE_TOO_MANY_ATTEMPTS', 'Demasiados intentos. Pide un código nuevo.');
  if (!sameCode(ch, code)) { ch.attempts += 1; await ch.save(); throw invalid; }
  ch.verifiedAt = new Date();
  await ch.save();
  res.json({ token: sign(ch.email), expiresInMinutes: 30 });
});

// ---------------------------------------------------------------- Google
router.post('/google', limiter(20), validate({ body: z.object({ idToken: z.string().min(10) }) }), async (req, res) => {
  let payload;
  try {
    payload = (await google.verifyIdToken({ idToken: req.valid.body.idToken, audience: env.GOOGLE_CLIENT_ID })).getPayload();
  } catch {
    throw httpError(401, 'GOOGLE_TOKEN_INVALID', 'No pudimos validar tu cuenta de Google. Intenta de nuevo.');
  }
  if (!payload?.email || !payload.email_verified) throw httpError(401, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Tu correo de Google no está verificado.');
  const email = payload.email.toLowerCase();
  if (!(await profilesFor(email)).length) throw NOT_FOUND(email);
  res.json({ token: sign(email), expiresInMinutes: 30 });
});

// ---------------------------------------------------------------- Todo lo que debe, agrupado por empresa
router.get('/me', requireSession, async (req, res) => {
  const profiles = await profilesFor(req.portalEmail);
  if (!profiles.length) throw httpError(401, 'PORTAL_SESSION_EXPIRED', 'Tu sesión terminó. Ingresa de nuevo.');
  const loans = await Loan.find({ borrowerId: { $in: profiles.map((p) => p.borrower._id) }, status: { $in: VISIBLE } })
    .setOptions({ skipTenant: true }).select(`${LOAN_SUMMARY} borrowerId orgId`).sort({ disbursementDate: -1 }).lean();
  const companies = profiles.map(({ borrower, org }) => ({
    org: { id: org._id, name: org.name, slug: org.slug, logoUrl: org.logoUrl || null, currency: org.currency },
    loans: loans.filter((l) => String(l.borrowerId) === String(borrower._id)).map(({ borrowerId, orgId, ...l }) => l),
  })).sort((a, b) => b.loans.length - a.loans.length);
  const first = profiles[0].borrower;
  res.json({ person: { firstName: first.firstName, lastName: first.lastName, email: req.portalEmail }, companies });
});

router.get('/loans/:orgId/:id', requireSession, validate({ params: z.object({ orgId: objectId, id: objectId }) }), async (req, res) => {
  const { orgId, id } = req.valid.params;
  const profile = (await profilesFor(req.portalEmail)).find((p) => String(p.org._id) === orgId);
  if (!profile) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
  const detail = await runWithContext({ orgId: profile.org._id, userId: null, portal: true }, () => loanDetail(id, profile.borrower._id));
  if (!detail) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
  AuditLog.create({ orgId: profile.org._id, actorType: 'borrower', actorId: profile.borrower._id, action: 'portal.view_loan', entity: 'Loan', entityId: id, ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id }).catch(() => {});
  res.json({ ...detail, company: { name: profile.org.name } });
});

export default router;
