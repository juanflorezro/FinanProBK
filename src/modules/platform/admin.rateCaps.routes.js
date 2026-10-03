import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { adminRole } from '../../middlewares/adminAuth.js';
import { httpError } from '../../utils/errors.js';
import { objectId, rateValue } from '../../utils/schemas.js';
import { audit } from '../audit/audit.service.js';
import { RateCap, CAP_MODALITIES } from './rateCap.model.js';

const router = Router();

const body = z.object({
  country: z.string().length(2).toUpperCase().default('CO'),
  modality: z.enum(CAP_MODALITIES).default('consumo'),
  maxAnnualEffectiveRate: rateValue,
  validFrom: z.coerce.date(),
  validTo: z.coerce.date().nullable().optional(),
  sourceResolution: z.string().trim().max(200).optional(),
  notes: z.string().max(500).optional(),
});

router.get('/', validate({ query: z.object({ country: z.string().length(2).toUpperCase().optional(), modality: z.enum(CAP_MODALITIES).optional() }) }), async (req, res) => {
  const filter = Object.fromEntries(Object.entries(req.valid.query).filter(([, v]) => v));
  const items = await RateCap.find(filter).sort({ country: 1, modality: 1, validFrom: -1 }).limit(500);
  const now = new Date();
  res.json(items.map((c) => ({ ...c.toJSON(), isCurrent: c.validFrom <= now && (!c.validTo || c.validTo >= now) })));
});

router.post('/', adminRole('finanzas'), validate({ body }), async (req, res) => {
  const cap = await RateCap.create(req.valid.body);
  await audit(req, { action: 'rate_cap.create', entity: 'RateCap', entityId: cap._id, after: cap });
  res.status(201).json(cap);
});

router.patch('/:id', adminRole('finanzas'), validate({ params: z.object({ id: objectId }), body: body.partial() }), async (req, res) => {
  const cap = await RateCap.findById(req.valid.params.id);
  if (!cap) throw httpError(404, 'RATE_CAP_NOT_FOUND', 'Tasa no encontrada');
  const before = cap.toObject();
  cap.set(req.valid.body);
  await cap.save();
  await audit(req, { action: 'rate_cap.update', entity: 'RateCap', entityId: cap._id, before, after: cap });
  res.json(cap);
});

export default router;
