import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { audit } from '../audit/audit.service.js';
import { PlatformAdmin, ADMIN_ROLES } from './platformAdmin.model.js';

// Solo superadmin. Los admins nuevos se crean con: npm run create-admin
const router = Router();

router.get('/', async (_req, res) => {
  res.json((await PlatformAdmin.find().sort({ createdAt: 1 })).map((a) => ({ ...a.toPublic(), status: a.status })));
});

router.patch('/:id', validate({
  params: z.object({ id: objectId }),
  body: z.object({ role: z.enum(ADMIN_ROLES).optional(), status: z.enum(['activo', 'bloqueado']).optional() }),
}), async (req, res) => {
  if (req.valid.params.id === String(req.admin._id)) throw httpError(400, 'CANNOT_EDIT_SELF', 'No puedes cambiarte a ti mismo');
  const admin = await PlatformAdmin.findById(req.valid.params.id);
  if (!admin) throw httpError(404, 'ADMIN_NOT_FOUND', 'Administrador no encontrado');
  const before = { role: admin.role, status: admin.status };
  admin.set(req.valid.body);
  await admin.save();
  await audit(req, { action: 'admin.update', entity: 'PlatformAdmin', entityId: admin._id, before, after: req.valid.body });
  res.json(admin.toPublic());
});

export default router;
