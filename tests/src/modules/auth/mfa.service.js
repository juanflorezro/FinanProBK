import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { env } from '../../config/env.js';
import { httpError } from '../../utils/errors.js';
import { encrypt, decrypt, hmac } from '../../utils/crypto.js';
import { User } from './user.model.js';

const ISSUER = 'FinanPro';
const MFA_TOKEN_TTL = '10m';
const BACKUP_CODES = 10;
const SECRET_FIELDS = '+mfa.totpSecret +mfa.totpPendingSecret +mfa.lastTotpStep +mfa.backupCodes';

export const loadUserWithMfa = (id) => User.findById(id).select(SECRET_FIELDS);

// ---------- token temporal entre el paso 1 (contraseña) y el paso 2 (código) ----------
export const signMfaToken = (user, method) =>
  jwt.sign({ sub: String(user._id), method }, env.JWT_ACCESS_SECRET, { expiresIn: MFA_TOKEN_TTL, audience: 'mfa' });

export function readMfaToken(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: 'mfa' });
  } catch {
    throw httpError(401, 'MFA_TOKEN_INVALID', 'La verificación venció, inicia sesión de nuevo');
  }
}

// ---------- códigos de respaldo ----------
const hashBackup = (code) => hmac(`backup:${code.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`);

function newBackupCodes() {
  return Array.from({ length: BACKUP_CODES }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase(); // 10 caracteres
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// ---------- verificación ----------
function checkTotp(user, encryptedSecret, code) {
  const result = verifySync({ secret: decrypt(encryptedSecret), token: code, epochTolerance: 30 });
  if (!result.valid) return false;
  if (user.mfa.lastTotpStep && result.timeStep <= user.mfa.lastTotpStep) return false; // ya usado
  user.mfa.lastTotpStep = result.timeStep;
  return true;
}

/** Acepta el código de 6 dígitos de la app o un código de respaldo (se consume). Modifica user; guárdalo después. */
export function verifySecondFactor(user, code) {
  const value = String(code ?? '').trim();
  if (/^\d{6}$/.test(value)) return checkTotp(user, user.mfa.totpSecret, value);

  const hash = hashBackup(value);
  const index = (user.mfa.backupCodes ?? []).indexOf(hash);
  if (index === -1) return false;
  user.mfa.backupCodes.splice(index, 1);
  user.markModified('mfa.backupCodes');
  return true;
}

// ---------- configuración por el usuario ----------
export async function startTotpSetup(userId) {
  const user = await loadUserWithMfa(userId);
  if (user.mfa?.totpEnabled) throw httpError(409, 'MFA_ALREADY_ENABLED', 'La app de autenticación ya está activa');
  const secret = generateSecret();
  user.mfa.totpPendingSecret = encrypt(secret);
  await user.save();
  // otpauthUrl se muestra como QR en el frontend; secret es para escribirlo a mano
  return { otpauthUrl: generateURI({ issuer: ISSUER, label: user.email, secret }), secret };
}

export async function enableTotp(userId, code) {
  const user = await loadUserWithMfa(userId);
  if (user.mfa?.totpEnabled) throw httpError(409, 'MFA_ALREADY_ENABLED', 'La app de autenticación ya está activa');
  if (!user.mfa?.totpPendingSecret) throw httpError(400, 'MFA_SETUP_REQUIRED', 'Primero inicia la configuración');
  if (!checkTotp(user, user.mfa.totpPendingSecret, code)) throw httpError(400, 'CODE_INVALID', 'Código incorrecto');

  const backupCodes = newBackupCodes();
  user.mfa.totpSecret = user.mfa.totpPendingSecret;
  user.mfa.totpPendingSecret = undefined;
  user.mfa.totpEnabled = true;
  user.mfa.totpEnabledAt = new Date();
  user.mfa.backupCodes = backupCodes.map(hashBackup);
  await user.save();
  return { backupCodes }; // se muestran una sola vez
}

export async function disableTotp(userId, code) {
  const user = await loadUserWithMfa(userId);
  if (!user.mfa?.totpEnabled) throw httpError(400, 'MFA_NOT_ENABLED', 'La app de autenticación no está activa');
  if (!verifySecondFactor(user, code)) throw httpError(400, 'CODE_INVALID', 'Código incorrecto');
  user.mfa = { totpEnabled: false };
  await user.save();
}

export async function regenerateBackupCodes(userId, code) {
  const user = await loadUserWithMfa(userId);
  if (!user.mfa?.totpEnabled) throw httpError(400, 'MFA_NOT_ENABLED', 'La app de autenticación no está activa');
  if (!verifySecondFactor(user, code)) throw httpError(400, 'CODE_INVALID', 'Código incorrecto');
  const backupCodes = newBackupCodes();
  user.mfa.backupCodes = backupCodes.map(hashBackup);
  await user.save();
  return { backupCodes };
}
