import { verifyAdminAccess } from '../modules/platform/adminAuth.service.js';
import { PlatformAdmin } from '../modules/platform/platformAdmin.model.js';
import { httpError } from '../utils/errors.js';

export async function authenticateAdmin(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(httpError(401, 'AUTH_REQUIRED', 'Inicia sesión como administrador'));
  let payload;
  try {
    payload = verifyAdminAccess(token);
  } catch (err) {
    return next(httpError(401, err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', 'Sesión inválida'));
  }
  const admin = await PlatformAdmin.findById(payload.sub);
  if (!admin || admin.status !== 'activo') return next(httpError(401, 'ADMIN_INACTIVE', 'Administrador inactivo'));
  req.admin = admin;
  next();
}

/** superadmin pasa siempre; los demás solo si su rol está en la lista. */
export const adminRole = (...roles) => (req, _res, next) =>
  req.admin.role === 'superadmin' || roles.includes(req.admin.role)
    ? next()
    : next(httpError(403, 'FORBIDDEN', 'Tu rol de administrador no permite esta acción'));
