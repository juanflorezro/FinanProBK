import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { httpError } from '../../utils/errors.js';
import { RateCap } from '../platform/rateCap.model.js';
import { Subscription } from '../platform/subscription.model.js';

const router = Router();
const WATERFALL = ['mora', 'cargo', 'interes', 'capital'];

/** Configuración de la organización. Cualquier miembro la puede ver. */
router.get('/', async (req, res) => {
  const org = req.org;
  const compliance = org.settings?.legalRateCompliance;
  const [cap, subscription] = await Promise.all([
    compliance?.enabled ? RateCap.currentFor(org.country, compliance.modality ?? 'consumo') : null,
    Subscription.findOne({ orgId: org._id }).populate('planId', 'name limits billingCycle'),
  ]);
  res.json({
    organization: {
      id: org._id, name: org.name, legalName: org.legalName, taxId: org.taxId, slug: org.slug,
      country: org.country, currency: org.currency, timezone: org.timezone, logoUrl: org.logoUrl, status: org.status,
    },
    settings: org.settings,
    rateCompliance: {
      enabled: Boolean(compliance?.enabled),
      policy: compliance?.policy,
      modality: compliance?.modality,
      currentCap: cap ? { maxAnnualEffectiveRate: cap.maxAnnualEffectiveRate, validFrom: cap.validFrom, sourceResolution: cap.sourceResolution } : null,
    },
    subscription: subscription && {
      plan: subscription.planId?.name, status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd, limits: subscription.limitsSnapshot,
    },
    membership: { role: req.membership.role },
  });
});

const body = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  legalName: z.string().trim().max(120).optional(),
  taxId: z.string().trim().max(30).optional(),
  logoUrl: z.string().url().max(500).or(z.literal('')).optional(),
  timezone: z.string().max(60).optional(),
  settings: z.object({
    paymentWaterfall: z.array(z.enum(WATERFALL)).length(4)
      .refine((a) => new Set(a).size === 4, 'Cada componente debe aparecer una sola vez').optional(),
    graceDays: z.number().int().min(0).max(60).optional(),
    receiptPrefix: z.string().trim().max(8).optional(),
    loanPrefix: z.string().trim().max(8).optional(),
    allowedRegimes: z.array(z.enum(['formal', 'informal'])).min(1).optional(),
    portalEnabled: z.boolean().optional(),
    portalOtpChannel: z.enum(['sms', 'whatsapp', 'email']).optional(),
  }).optional(),
});

/** Solo dueño o admin. La acogida a la ley de tasa la maneja el administrador de la plataforma. */
router.patch('/', can('org.update'), validate({ body }), async (req, res) => {
  if (req.org.status !== 'activa') throw httpError(423, 'ORG_READ_ONLY', 'La organización está en solo lectura');
  const { settings, ...rest } = req.valid.body;
  req.org.set(rest);
  if (settings) {
    for (const [k, v] of Object.entries(settings)) req.org.settings[k] = v;
    req.org.markModified('settings');
  }
  await req.org.save();
  res.json({ organization: req.org, settings: req.org.settings });
});

export default router;
