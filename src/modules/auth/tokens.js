import jwt from 'jsonwebtoken';
import { env, isProd } from '../../config/env.js';
import { sha256, randomToken } from '../../utils/crypto.js';
import { Session } from './session.model.js';

export const REFRESH_COOKIE = 'rt';

export const signAccessToken = (user) =>
  jwt.sign({ sub: String(user._id) }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL, audience: 'access' });

export const verifyAccessToken = (token) => jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: 'access' });

export const SESSION_IDLE_MS = env.SESSION_IDLE_HOURS * 3_600_000;

/**
 * Sesión con vencimiento por inactividad: dura SESSION_IDLE_HOURS desde el último uso y se renueva
 * cada vez que la app refresca el token (al abrir o recargar). Tope absoluto: SESSION_MAX_DAYS.
 */
export async function createSession(user, { ip, userAgent } = {}, { familyStartedAt = new Date() } = {}) {
  const refreshToken = randomToken();
  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: sha256(refreshToken),
    ip,
    userAgent,
    familyStartedAt,
    expiresAt: new Date(Date.now() + SESSION_IDLE_MS),
  });
  return { session, refreshToken, accessToken: signAccessToken(user) };
}

const baseCookie = () => ({
  httpOnly: true,
  secure: isProd || env.COOKIE_SAMESITE === 'none',
  sameSite: env.COOKIE_SAMESITE,
  path: '/api/auth',
});

export const refreshCookieOptions = () => ({ ...baseCookie(), maxAge: SESSION_IDLE_MS });

// ---------- Dispositivo de confianza: después de entrar con código, no se vuelve a pedir en este equipo
export const TRUSTED_COOKIE = 'td';
export const trustedCookieOptions = () => ({ ...baseCookie(), maxAge: env.TRUSTED_DEVICE_DAYS * 86_400_000 });

export const signTrustedDevice = (user) =>
  jwt.sign({ sub: String(user._id) }, env.JWT_REFRESH_SECRET, { audience: 'trusted-device', expiresIn: `${env.TRUSTED_DEVICE_DAYS}d` });

export function isTrustedDevice(token, user) {
  if (!token || !env.TRUSTED_DEVICE_DAYS) return false;
  try {
    const p = jwt.verify(token, env.JWT_REFRESH_SECRET, { audience: 'trusted-device' });
    if (p.sub !== String(user._id)) return false;
    return !user.trustedDevicesRevokedAt || p.iat * 1000 > user.trustedDevicesRevokedAt.getTime();
  } catch { return false; }
}
