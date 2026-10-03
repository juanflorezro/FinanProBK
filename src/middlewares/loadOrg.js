import mongoose from 'mongoose';
import { Membership } from '../modules/users/membership.model.js';
import { Organization } from '../modules/organizations/organization.model.js';
import { httpError } from '../utils/errors.js';

/** Lee la org del header X-Org-Id y valida que el usuario sea miembro activo. */
export async function loadOrg(req, _res, next) {
  const orgId = req.get('x-org-id');
  if (!orgId || !mongoose.isValidObjectId(orgId)) return next(httpError(400, 'ORG_REQUIRED', 'Falta el header X-Org-Id'));

  const membership = await Membership.findOne({ orgId, userId: req.user._id, status: 'activa' });
  if (!membership) return next(httpError(403, 'NOT_A_MEMBER', 'No perteneces a esta organización'));

  const org = await Organization.findById(orgId);
  if (!org) return next(httpError(404, 'ORG_NOT_FOUND', 'Organización no encontrada'));

  req.membership = membership;
  req.org = org;
  next();
}
