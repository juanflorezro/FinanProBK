import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { objectId } from '../../utils/schemas.js';
import { CashAccount } from './cashAccount.model.js';

const router = Router();

// Por defecto solo activas (para los formularios de pago); ?todas=1 incluye inactivas
router.get('/', can('cash.read'), async (req, res) => {
  const filter = req.query.todas === '1' ? {} : { isActive: true };
  res.json(await CashAccount.find(filter).sort({ isActive: -1, name: 1 }));
});

router.post('/', can('cash.create'), validate({
  body: z.object({
    name: z.string().trim().min(2).max(60),
    type: z.enum(['efectivo', 'banco', 'billetera_digital']).default('efectivo'),
    bankName: z.string().trim().max(60).optional(),
    accountMask: z.string().regex(/^\d{4}$/).optional(),
    custodianMembershipId: objectId.optional(),
  }),
}), async (req, res) => {
  res.status(201).json(await CashAccount.create({ ...req.valid.body, currency: req.org.currency }));
});

export default router;
