import jwt from 'jsonwebtoken';
import { env, isProd } from '../../config/env.js';
import { sha256, randomToken } from '../../utils/crypto.js';
import { Session } from './session.model.js';

export const REFRESH_COOKIE = 'rt';

export const signAccessToken = (user) =>
  jwt.sign({ sub: String(user._id) }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL, audience: 'access' });

export const verifyAccessToken = (token) => jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: 'access' });

export async function createSession(user, { ip, userAgent } = {}) {
  const refreshToken = randomToken();
  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: sha256(refreshToken),
    ip,
    userAgent,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  });
  return { session, refreshToken, accessToken: signAccessToken(user) };
}

export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: isProd || env.COOKIE_SAMESITE === 'none',
  sameSite: env.COOKIE_SAMESITE,
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
});
