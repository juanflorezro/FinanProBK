import { hasPermission } from '../config/permissions.js';
import { httpError } from '../utils/errors.js';

export const can = (permission) => (req, _res, next) =>
  hasPermission(req.membership?.role, permission)
    ? next()
    : next(httpError(403, 'FORBIDDEN', `Tu rol no permite: ${permission}`));
