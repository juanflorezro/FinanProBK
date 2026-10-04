import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';
import { validate } from '../../middlewares/validate.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { documentHash, maskEmail } from '../../utils/crypto.js';
import { runWithContext } from '../../db/context.js';
import { sendMail } from '../../services/notifications/mailer.js';
import { Organization } from '../organizations/organization.model.js';
import { Borrower } from '../borrowers/borrower.model.js';
import { Loan } from '../loans/loan.model.js';
import { Payment } from '../payments/payment.model.js';
import { getInstallments } from '../loans/loan.service.js';
import { AuditLog } from '../audit/auditLog.model.js';
import { PortalChallenge } from './portalChallenge.model.js';
import { newPortalChallenge, sameCode } from './portal.codes.js';

/**
 * Portal del deudor (cliente de la empresa). Se entra SIEMPRE con el correo registrado en su ficha:
 * con Google (mismo correo) o con documento + código enviado a ese correo.
 * Público, solo lectura y aislado por organización (/api/portal/:slug/...).
 */
const router = Router({ mergeParams: true });
const CODE_MIN = 10;
const SESSION = '30m';
const VISIBLE = ['desembolsado', 'al_dia', 'en_mora', 'reestructurado', 'pagado', 'castigado'];

const codeLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'TOO_MANY', message: 'Demasiados intentos. Espera unos minutos.' } });
const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'TOO_MANY', message: 'Demasiados intentos. Espera unos minutos.' } });


async function loadOrg(req, _res, next) {
  const org = await Organization.findOne({ slug: String(req.params.slug).toLowerCase() });
  if (!org || ['suspendida', 'archivada'].includes(org.status) || org.settings?.portalEnabled === false) {
    return next(httpError(404, 'PORTAL_NOT_FOUND', 'Este portal no existe o no está disponible'));
  }
  req.org = org;
  next();
}

function requirePortal(req, _res, next) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: 'portal' });
    if (p.org !== String(req.org._id)) throw new Error('org');
    req.borrowerId = p.sub;
  } catch {
    return next(httpError(401, 'PORTAL_SESSION_EXPIRED', 'Tu sesión terminó. Ingresa de nuevo.'));
  }
  runWithContext({ orgId: req.org._id, userId: null, portal: true }, () => next());
}

const logAccess = (req, action, entityId) => AuditLog.create({
  orgId: req.org._id, actorType: 'borrower', actorId: req.borrowerId, action, entity: 'Borrower', entityId: req.borrowerId,
  ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id,
}).catch(() => {});

router.use(loadOrg);

// ---------------------------------------------------------------- Datos públicos de la empresa
router.get('/', (req, res) => {
  res.json({ name: req.org.name, logoUrl: req.org.logoUrl || null, country: req.org.country, currency: req.org.currency });
});

// ---------------------------------------------------------------- Paso 1: documento → código
router.post('/request-code', codeLimiter, validate({
  body: z.object({ docType: z.enum(['CC', 'CE', 'PPT', 'PAS', 'NIT']), docNumber: z.string().trim().regex(/^[0-9A-Za-z-]{4,20}$/, 'Documento inválido') }),
}), async (req, res) => {
  const { docType, docNumber } = req.valid.body;
  const borrower = await runWithContext({ orgId: req.org._id }, () => Borrower.findOne({ docNumberHash: documentHash(req.org._id, docType, docNumber) }).select('email firstName status').exec());
  if (!borrower || borrower.status === 'bloqueado') {
    throw httpError(404, 'NOT_FOUND', `No encontramos préstamos con ese documento en ${req.org.name}. Revisa el tipo y el número.`);
  }
  if (!borrower.email) {
    throw httpError(409, 'NO_EMAIL', `No tienes un correo registrado. Pide a ${req.org.name} que registre tu correo para poder entrar.`);
  }
  const recent = await PortalChallenge.findOne({ borrowerId: borrower._id, channel: 'email', createdAt: { $gt: new Date(Date.now() - 60_000) } });
  if (recent) throw httpError(429, 'CODE_COOLDOWN', 'Ya te enviamos un código. Espera un minuto para pedir otro.');

  const { challenge, code } = newPortalChallenge({ orgId: req.org._id, borrowerId: borrower._id, channel: 'email', minutes: CODE_MIN, ip: req.ip });
  const text = `${req.org.name}: tu código para consultar tus préstamos es ${code}. Vence en ${CODE_MIN} minutos. No lo compartas.`;
  await sendMail({ to: borrower.email, subject: `Tu código de acceso: ${code}`, text, html: `<p>Hola ${borrower.firstName},</p><p>Tu código para consultar tus préstamos con <strong>${req.org.name}</strong> es:</p><p style="font-size:30px;letter-spacing:8px;font-weight:bold">${code}</p><p>Vence en ${CODE_MIN} minutos. No lo compartas con nadie.</p>` });
  await challenge.save();
  res.json({ challengeId: challenge._id, expiresInMinutes: CODE_MIN, sentTo: maskEmail(borrower.email) });
});

// ---------------------------------------------------------------- Paso 2: código → sesión
router.post('/verify', verifyLimiter, validate({
  body: z.object({ challengeId: objectId, code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos') }),
}), async (req, res) => {
  const { challengeId, code } = req.valid.body;
  const ch = await PortalChallenge.findOne({ _id: challengeId, orgId: req.org._id });
  const invalid = httpError(400, 'CODE_INVALID', 'Código incorrecto o vencido');
  if (!ch || ch.verifiedAt || ch.expiresAt < new Date()) throw invalid;
  if (ch.attempts >= 5) throw httpError(429, 'CODE_TOO_MANY_ATTEMPTS', 'Demasiados intentos. Pide un código nuevo.');
  const ok = Boolean(ch.borrowerId) && sameCode(ch, code);
  if (!ok) {
    ch.attempts += 1;
    await ch.save();
    throw invalid;
  }
  ch.verifiedAt = new Date();
  await ch.save();
  const token = jwt.sign({ sub: String(ch.borrowerId), org: String(req.org._id) }, env.JWT_ACCESS_SECRET, { audience: 'portal', expiresIn: SESSION });
  req.borrowerId = ch.borrowerId;
  await logAccess(req, 'portal.login');
  res.json({ token, expiresInMinutes: 30 });
});

// ---------------------------------------------------------------- Entrar con Google
const google = new OAuth2Client(env.GOOGLE_CLIENT_ID);

router.post('/google', verifyLimiter, validate({ body: z.object({ idToken: z.string().min(10) }) }), async (req, res) => {
  let payload;
  try {
    payload = (await google.verifyIdToken({ idToken: req.valid.body.idToken, audience: env.GOOGLE_CLIENT_ID })).getPayload();
  } catch {
    throw httpError(401, 'GOOGLE_TOKEN_INVALID', 'No pudimos validar tu cuenta de Google. Intenta de nuevo.');
  }
  if (!payload?.email || !payload.email_verified) throw httpError(401, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Tu correo de Google no está verificado.');
  const email = payload.email.toLowerCase();
  const matches = await runWithContext({ orgId: req.org._id }, () => Borrower.find({ email, status: { $ne: 'bloqueado' } }).select('_id').limit(2).exec());
  if (matches.length === 0) {
    throw httpError(404, 'EMAIL_NOT_REGISTERED', `El correo ${email} no está registrado en ${req.org.name}. Pide que lo registren en tu ficha o entra con tu documento.`);
  }
  if (matches.length > 1) {
    throw httpError(409, 'EMAIL_SHARED', 'Ese correo está en más de una ficha. Entra con tu documento y el código al correo.');
  }
  const token = jwt.sign({ sub: String(matches[0]._id), org: String(req.org._id) }, env.JWT_ACCESS_SECRET, { audience: 'portal', expiresIn: SESSION });
  req.borrowerId = matches[0]._id;
  await logAccess(req, 'portal.login_google');
  res.json({ token, expiresInMinutes: 30 });
});

// ---------------------------------------------------------------- Consultas (solo lectura)
router.get('/me', requirePortal, async (req, res) => {
  const borrower = await Borrower.findById(req.borrowerId).select('firstName lastName docType docNumber phone email');
  if (!borrower) throw httpError(401, 'PORTAL_SESSION_EXPIRED', 'Tu sesión terminó. Ingresa de nuevo.');
  const loans = await Loan.find({ borrowerId: borrower._id, status: { $in: VISIBLE } }).sort({ disbursementDate: -1 })
    .select('loanNumber principal currency status balancePrincipal balanceInterest balanceLateInterest balanceFees totalPaid daysPastDue nextDueDate nextDueAmount disbursementDate maturityDate amortization frequency termCount rate rateBasis rateAnnual closedAt');
  res.json({ borrower, loans });
});

router.get('/loans/:id', requirePortal, validate({ params: z.object({ slug: z.string(), id: objectId }) }), async (req, res) => {
  const loan = await Loan.findOne({ _id: req.valid.params.id, borrowerId: req.borrowerId, status: { $in: VISIBLE } })
    .select('loanNumber principal currency status balancePrincipal balanceInterest balanceLateInterest balanceFees totalPaid daysPastDue nextDueDate nextDueAmount disbursementDate maturityDate amortization frequency termCount rate rateBasis rateAnnual lateRate lateRateBasis graceDays closedAt');
  if (!loan) throw httpError(404, 'LOAN_NOT_FOUND', 'Préstamo no encontrado');
  const [installments, payments] = await Promise.all([
    getInstallments(loan),
    Payment.find({ loanId: loan._id }).sort({ paidAt: -1 })
      .select('receiptNumber amount currency method paidAt status isReversal appliedPrincipal appliedInterest appliedLateInterest appliedFees unappliedAmount'),
  ]);
  await logAccess(req, 'portal.view_loan');
  res.json({
    loan,
    installments: installments.map((i) => ({
      _id: i._id, number: i.number, dueDate: i.dueDate, status: i.status, daysPastDue: i.daysPastDue,
      principalDue: i.principalDue, interestDue: i.interestDue, feesDue: i.feesDue, lateInterest: i.lateInterestAccrued,
      paid: i.principalPaid + i.interestPaid + i.feesPaid + i.lateInterestPaid, waived: i.waived, pending: i.pending,
    })),
    payments,
    company: { name: req.org.name },
  });
});

export default router;
