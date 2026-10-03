import argon2 from 'argon2';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';
import { httpError } from '../../utils/errors.js';
import { sha256 } from '../../utils/crypto.js';
import { User } from './user.model.js';
import { AuthIdentity } from './authIdentity.model.js';
import { AllowedEmail } from './allowedEmail.model.js';
import { Session } from './session.model.js';
import { Membership } from '../users/membership.model.js';
import { createSession, signAccessToken } from './tokens.js';
import { sendCode, consumeCode } from './verification.service.js';

const google = new OAuth2Client(env.GOOGLE_CLIENT_ID);
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const notEnabled = () =>
  httpError(403, 'EMAIL_NOT_ENABLED', 'Este correo no está habilitado. Contacta al administrador de la plataforma.');

/** La regla de acceso: correo habilitado vigente, o usuario con membresía activa. */
export async function assertEmailAllowed(email) {
  const user = await User.findOne({ email });
  if (user?.status === 'bloqueado') throw httpError(403, 'USER_BLOCKED', 'Usuario bloqueado');
  if (user && await Membership.exists({ userId: user._id, status: 'activa' })) return user;
  if (await AllowedEmail.exists(AllowedEmail.validFilter(email))) return user;
  throw notEnabled();
}

/** Convierte invitaciones a una org (cobrador, analista...) en membresías. */
export async function claimInvitations(user) {
  if (!user.emailVerified) return;
  const invites = await AllowedEmail.find(AllowedEmail.validFilter(user.email, { orgId: { $ne: null } }));
  for (const inv of invites) {
    await Membership.updateOne(
      { orgId: inv.orgId, userId: user._id },
      { $setOnInsert: { role: inv.intendedRole, status: 'activa', invitedBy: inv.invitedById, joinedAt: new Date() } },
      { upsert: true },
    );
    inv.status = 'usado';
    inv.usedAt = new Date();
    inv.usedByUserId = user._id;
    await inv.save();
    user.defaultOrgId ??= inv.orgId;
  }
  if (user.isModified()) await user.save();
}

async function finishLogin(user, meta) {
  await claimInvitations(user);
  user.lastLoginAt = new Date();
  await user.save();
  const { accessToken, refreshToken } = await createSession(user, meta);
  return { user, accessToken, refreshToken };
}

export async function loginWithGoogle(idToken, meta) {
  let payload;
  try {
    const ticket = await google.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw httpError(401, 'GOOGLE_TOKEN_INVALID', 'Token de Google inválido');
  }
  if (!payload?.email || !payload.email_verified) {
    throw httpError(401, 'GOOGLE_EMAIL_NOT_VERIFIED', 'El correo de Google no está verificado');
  }
  const email = payload.email.toLowerCase();
  let user = await assertEmailAllowed(email);

  if (!user) {
    user = await User.create({ email, name: payload.name, avatarUrl: payload.picture, emailVerified: true });
  } else if (!user.emailVerified) {
    user.emailVerified = true; // Google confirma que el correo es suyo
  }

  const identity = await AuthIdentity.findOne({ provider: 'google', providerUid: payload.sub });
  if (identity && !identity.userId.equals(user._id)) throw httpError(409, 'IDENTITY_CONFLICT', 'Esta cuenta de Google ya está vinculada a otro usuario');
  if (!identity) await AuthIdentity.create({ userId: user._id, provider: 'google', providerUid: payload.sub, lastUsedAt: new Date() });
  else { identity.lastUsedAt = new Date(); await identity.save(); }

  return finishLogin(user, meta);
}

/**
 * Registro en dos pasos para que nadie cree una cuenta con un correo que no es suyo:
 * 1) startRegistration envía un código al correo.
 * 2) completeRegistration valida el código y recién ahí crea la contraseña.
 */
export async function startRegistration(email) {
  email = email.toLowerCase();
  await assertEmailAllowed(email);
  if (await AuthIdentity.exists({ provider: 'password', providerUid: email })) {
    throw httpError(409, 'EMAIL_ALREADY_REGISTERED', 'Este correo ya tiene contraseña. Inicia sesión o recupérala.');
  }
  return sendCode(email, 'verify_email');
}

export async function completeRegistration({ email, code, password, name }, meta) {
  email = email.toLowerCase();
  let user = await assertEmailAllowed(email);
  if (await AuthIdentity.exists({ provider: 'password', providerUid: email })) {
    throw httpError(409, 'EMAIL_ALREADY_REGISTERED', 'Este correo ya tiene contraseña. Inicia sesión o recupérala.');
  }
  await consumeCode(email, 'verify_email', code);

  user ??= await User.create({ email, name });
  user.emailVerified = true;
  user.name ??= name;
  await AuthIdentity.create({
    userId: user._id,
    provider: 'password',
    providerUid: email,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    passwordUpdatedAt: new Date(),
  });
  return finishLogin(user, meta);
}

/** Siempre responde igual para no revelar qué correos existen. */
export async function requestPasswordReset(email) {
  email = email.toLowerCase();
  const user = await User.findOne({ email, status: 'activo' });
  if (!user) return;
  try {
    await sendCode(email, 'reset_password');
  } catch (err) {
    if (err.code !== 'CODE_COOLDOWN') throw err;
  }
}

export async function resetPassword({ email, code, password }, meta) {
  email = email.toLowerCase();
  const user = await User.findOne({ email, status: 'activo' });
  if (!user) throw httpError(400, 'CODE_EXPIRED', 'El código venció, pide uno nuevo');
  await consumeCode(email, 'reset_password', code);

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await AuthIdentity.findOneAndUpdate(
    { provider: 'password', providerUid: email },
    {
      $set: { passwordHash, passwordUpdatedAt: new Date(), failedAttempts: 0, lockedUntil: null },
      $setOnInsert: { userId: user._id }, // usuarios que solo tenían Google ahora también tienen contraseña
    },
    { upsert: true },
  );
  user.emailVerified = true;
  await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await assertEmailAllowed(email);
  return finishLogin(user, meta);
}

export async function loginWithEmail({ email, password }, meta) {
  email = email.toLowerCase();
  const invalid = httpError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos');
  const identity = await AuthIdentity.findOne({ provider: 'password', providerUid: email }).select('+passwordHash');
  if (!identity) throw invalid;
  if (identity.lockedUntil && identity.lockedUntil > new Date()) {
    throw httpError(423, 'ACCOUNT_LOCKED', `Demasiados intentos. Intenta de nuevo en ${LOCK_MINUTES} minutos.`);
  }
  if (!(await argon2.verify(identity.passwordHash, password))) {
    identity.failedAttempts += 1;
    if (identity.failedAttempts >= MAX_ATTEMPTS) {
      identity.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      identity.failedAttempts = 0;
    }
    await identity.save();
    throw invalid;
  }
  identity.failedAttempts = 0;
  identity.lockedUntil = undefined;
  identity.lastUsedAt = new Date();
  await identity.save();

  const user = await assertEmailAllowed(email);
  if (!user) throw invalid;
  return finishLogin(user, meta);
}

/** Rota el refresh token. Si llega uno ya usado, se asume robo y se cierran todas las sesiones. */
export async function refreshSession(refreshToken, meta) {
  if (!refreshToken) throw httpError(401, 'NO_REFRESH_TOKEN', 'Sesión expirada');
  const session = await Session.findOne({ refreshTokenHash: sha256(refreshToken) });
  if (!session || session.expiresAt < new Date()) throw httpError(401, 'SESSION_EXPIRED', 'Sesión expirada');
  if (session.revokedAt) {
    await Session.updateMany({ userId: session.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw httpError(401, 'SESSION_REUSED', 'Sesión inválida, vuelve a iniciar sesión');
  }
  const user = await User.findById(session.userId);
  if (!user || user.status !== 'activo') throw httpError(401, 'USER_INACTIVE', 'Usuario inactivo');

  const next = await createSession(user, meta);
  session.revokedAt = new Date();
  session.replacedById = next.session._id;
  await session.save();
  return { user, accessToken: next.accessToken, refreshToken: next.refreshToken };
}

export async function logout(refreshToken) {
  if (!refreshToken) return;
  await Session.updateOne({ refreshTokenHash: sha256(refreshToken), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export { signAccessToken };
