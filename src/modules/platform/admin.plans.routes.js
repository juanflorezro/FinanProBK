import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { adminRole } from '../../middlewares/adminAuth.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { audit } from '../audit/audit.service.js';
import { Plan } from './plan.model.js';

const router = Router();

const limit = z.number().int().min(0).max(1_000_000);
const planBody = z.object({
  code: z.string().trim().min(2).max(20),
  name: z.string().trim().min(2).max(60),
  description: z.string().max(500).optional(),
  price: z.number().int().min(0),
  currency: z.string().length(3).toUpperCase().default('COP'),
  billingCycle: z.enum(['mensual', 'trimestral', 'anual']).default('mensual'),
  limits: z.object({ maxUsers: limit.default(0), maxBorrowers: limit.default(0), maxActiveLoans: limit.default(0) }).default({}),
  features: z.array(z.string().max(80)).max(30).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

router.get('/', async (_req, res) => {
  res.json(await Plan.find().sort({ sortOrder: 1, price: 1 }));
});

router.post('/', adminRole('finanzas'), validate({ body: planBody }), async (req, res) => {
  const plan = await Plan.create(req.valid.body);
  await audit(req, { action: 'plan.create', entity: 'Plan', entityId: plan._id, after: plan });
  res.status(201).json(plan);
});

router.patch('/:id', adminRole('finanzas'), validate({ params: z.object({ id: objectId }), body: planBody.partial() }), async (req, res) => {
  const plan = await Plan.findById(req.valid.params.id);
  if (!plan) throw httpError(404, 'PLAN_NOT_FOUND', 'Plan no encontrado');
  const before = plan.toObject();
  plan.set(req.valid.body);
  await plan.save();
  await audit(req, { action: 'plan.update', entity: 'Plan', entityId: plan._id, before, after: plan });
  res.json(plan); // los límites nuevos aplican a cada cliente cuando renueva o cambia de plan
});

export default router;
