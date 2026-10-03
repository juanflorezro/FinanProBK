import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { objectId } from '../../utils/schemas.js';
import { CashAccount } from './cashAccount.model.js';

const router = Router();

router.get('/', can('cash.read'), async (_req, res) => {
  res.json(await CashAccount.find({ isActive: true }).sort({ name: 1 }));
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
