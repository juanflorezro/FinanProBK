import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { verifySync } from 'otplib';
import { env } from '../../config/env.js';
import { httpError } from '../../utils/errors.js';
import { decrypt, sha256, randomToken } from '../../utils/crypto.js';
import { Session } from '../auth/session.model.js';
import { PlatformAdmin } from './platformAdmin.model.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 30;
const ACCESS_TTL = '20m';
const REFRESH_HOURS = 12;

export const signAdminAccess = (admin) =>
  jwt.sign({ sub: String(admin._id), role: admin.role }, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TTL, audience: 'admin' });

export const verifyAdminAccess = (token) => jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: 'admin' });

const signStepToken = (admin) =>
  jwt.sign({ sub: String(admin._id) }, env.JWT_ACCESS_SECRET, { expiresIn: '5m', audience: 'admin-mfa' });

async function fail(admin) {
  admin.failedAttempts += 1;
  if (admin.failedAttempts >= MAX_ATTEMPTS) {
    admin.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
    admin.failedAttempts = 0;
  }
  await admin.save();
}

function assertUsable(admin) {
  if (!admin || admin.status !== 'activo') throw httpError(401, 'INVALID_CREDENTIALS', 'Credenciales incorrectas');
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    throw httpError(423, 'ACCOUNT_LOCKED', `Cuenta bloqueada ${LOCK_MINUTES} minutos por intentos fallidos`);
  }
}

async function openSession(admin, meta) {
  const refreshToken = randomToken();
  await Session.create({
    kind: 'admin',
    userId: admin._id,
    refreshTokenHash: sha256(refreshToken),
    ip: meta.ip,
    userAgent: meta.userAgent,
    expiresAt: new Date(Date.now() + REFRESH_HOURS * 3_600_000),
  });
  return { admin, accessToken: signAdminAccess(admin), refreshToken };
}

/** Paso 1: correo + contraseña. Los admins siempre usan app de autenticación. */
export async function adminLogin({ email, password }) {
  const admin = await PlatformAdmin.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!admin) throw httpError(401, 'INVALID_CREDENTIALS', 'Credenciales incorrectas');
  assertUsable(admin);
  if (!(await argon2.verify(admin.passwordHash, password))) {
    await fail(admin);
    throw httpError(401, 'INVALID_CREDENTIALS', 'Credenciales incorrectas');
  }
  return { mfaRequired: true, method: 'totp', mfaToken: signStepToken(admin) };
}

/** Paso 2: código de la app. */
export async function adminLoginVerify({ mfaToken, code }, meta) {
  let payload;
  try {
    payload = jwt.verify(mfaToken, env.JWT_ACCESS_SECRET, { audience: 'admin-mfa' });
  } catch {
    throw httpError(401, 'MFA_TOKEN_INVALID', 'La verificación venció, inicia sesión de nuevo');
  }
  const admin = await PlatformAdmin.findById(payload.sub).select('+totpSecret +lastTotpStep');
  assertUsable(admin);

  const result = verifySync({ secret: decrypt(admin.totpSecret), token: String(code).trim(), epochTolerance: 30 });
  if (!result.valid || (admin.lastTotpStep && result.timeStep <= admin.lastTotpStep)) {
    await fail(admin);
    throw httpError(400, 'CODE_INVALID', 'Código incorrecto');
  }
  admin.lastTotpStep = result.timeStep;
  admin.failedAttempts = 0;
  admin.lockedUntil = undefined;
  admin.lastLoginAt = new Date();
  await admin.save();
  return openSession(admin, meta);
}

export async function adminRefresh(refreshToken, meta) {
  if (!refreshToken) throw httpError(401, 'NO_REFRESH_TOKEN', 'Sesión expirada');
  const session = await Session.findOne({ refreshTokenHash: sha256(refreshToken), kind: 'admin' });
  if (!session || session.expiresAt < new Date()) throw httpError(401, 'SESSION_EXPIRED', 'Sesión expirada');
  if (session.revokedAt) {
    await Session.updateMany({ kind: 'admin', userId: session.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw httpError(401, 'SESSION_REUSED', 'Sesión inválida, vuelve a iniciar sesión');
  }
  const admin = await PlatformAdmin.findById(session.userId);
  if (!admin || admin.status !== 'activo') throw httpError(401, 'ADMIN_INACTIVE', 'Administrador inactivo');
  session.revokedAt = new Date();
  await session.save();
  return openSession(admin, meta);
}

export async function adminLogout(refreshToken) {
  if (!refreshToken) return;
  await Session.updateOne({ refreshTokenHash: sha256(refreshToken), kind: 'admin' }, { $set: { revokedAt: new Date() } });
}
