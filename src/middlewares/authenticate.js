import { verifyAccessToken } from '../modules/auth/tokens.js';
import { User } from '../modules/auth/user.model.js';
import { httpError } from '../utils/errors.js';

export async function authenticate(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(httpError(401, 'AUTH_REQUIRED', 'Inicia sesión'));

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return next(httpError(401, err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', 'Sesión inválida'));
  }
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'activo') return next(httpError(401, 'USER_INACTIVE', 'Usuario inactivo'));
  req.user = user;
  next();
}
