import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { objectId, pagination } from '../../utils/schemas.js';
import { AuditLog } from '../audit/auditLog.model.js';

const router = Router();

router.get('/', validate({
  query: pagination.extend({
    orgId: objectId.optional(),
    entityId: objectId.optional(),
    action: z.string().max(60).optional(),
    actorType: z.enum(['platform_admin', 'user', 'borrower', 'system']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
}), async (req, res) => {
  const { page, limit, from, to, action, ...rest } = req.valid.query;
  const filter = Object.fromEntries(Object.entries(rest).filter(([, v]) => v));
  if (action) filter.action = action.endsWith('.') ? { $regex: `^${action.replace(/\./g, '\\.')}` } : action;
  if (from || to) filter.at = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});

export default router;
