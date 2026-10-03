import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../middlewares/permissions.js';
import { httpError } from '../../utils/errors.js';
import { documentHash } from '../../utils/crypto.js';
import { objectId, pagination } from '../../utils/schemas.js';
import { nextSeq } from '../counters/counter.model.js';
import { Borrower } from './borrower.model.js';
import { Loan } from '../loans/loan.model.js';
import { borrowerQuery, buildBorrowerFilter } from '../../utils/listFilters.js';
import { newPortalChallenge } from '../portal/portal.codes.js';
import { audit } from '../audit/audit.service.js';
import { assertPlanLimit } from '../../utils/planLimits.js';

const router = Router();

const fields = {
  docType: z.enum(['CC', 'CE', 'PPT', 'PAS', 'NIT']),
  docNumber: z.string().trim().regex(/^[0-9A-Za-z-]{4,20}$/, 'Documento inválido'),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  birthDate: z.coerce.date().optional(),
  phone: z.string().trim().min(7).max(20),
  phoneAlt: z.string().trim().max(20).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  neighborhood: z.string().trim().max(80).optional(),
  occupation: z.string().trim().max(80).optional(),
  monthlyIncome: z.number().int().nonnegative().optional(),
  riskRating: z.enum(['A', 'B', 'C', 'D']).optional(),
  assignedCollectorId: objectId.optional(),
};

router.post('/', can('borrower.create'), validate({ body: z.object(fields) }), async (req, res) => {
  const body = req.valid.body;
  await assertPlanLimit(req.org, 'maxBorrowers');
  const code = await nextSeq(req.org._id, 'borrower');
  const borrower = await Borrower.create({
    ...body,
    code: `C${code}`,
    docNumberHash: documentHash(req.org._id, body.docType, body.docNumber),
  });
  res.status(201).json(borrower);
});

router.get('/', can('borrower.read'), validate({ query: pagination.merge(borrowerQuery) }), async (req, res) => {
  const { page, limit, ...f } = req.valid.query;
  const { filter, sort } = await buildBorrowerFilter(f);
  const [items, total] = await Promise.all([
    Borrower.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Borrower.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});

router.get('/:id', can('borrower.read'), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const borrower = await Borrower.findById(req.valid.params.id);
  if (!borrower) throw httpError(404, 'BORROWER_NOT_FOUND', 'Deudor no encontrado');
  const loans = await Loan.find({ borrowerId: borrower._id }).sort({ createdAt: -1 });
  res.json({ borrower, loans });
});

const editable = z.object(fields).omit({ docType: true, docNumber: true }).partial();

router.patch('/:id', can('borrower.update'), validate({ params: z.object({ id: objectId }), body: editable }), async (req, res) => {
  const borrower = await Borrower.findById(req.valid.params.id);
  if (!borrower) throw httpError(404, 'BORROWER_NOT_FOUND', 'Deudor no encontrado');
  borrower.set(req.valid.body);
  await borrower.save();
  res.json(borrower);
});

/** Código de acceso al portal para que la empresa se lo comparta al deudor (WhatsApp, en persona). Dura 60 minutos. */
router.post('/:id/portal-code', can('borrower.read'), validate({ params: z.object({ id: objectId }) }), async (req, res) => {
  const borrower = await Borrower.findById(req.valid.params.id);
  if (!borrower) throw httpError(404, 'BORROWER_NOT_FOUND', 'Deudor no encontrado');
  if (borrower.status === 'bloqueado') throw httpError(409, 'BORROWER_BLOCKED', 'El deudor está bloqueado');
  if (req.org.settings?.portalEnabled === false) throw httpError(409, 'PORTAL_DISABLED', 'El portal está desactivado en Configuración');
  const { challenge, code } = newPortalChallenge({ orgId: req.org._id, borrowerId: borrower._id, channel: 'manual', minutes: 60, ip: req.ip });
  await challenge.save();
  await audit(req, { action: 'portal.code_generated', entity: 'Borrower', entityId: borrower._id, orgId: req.org._id });
  res.status(201).json({ code, expiresAt: challenge.expiresAt, docType: borrower.docType });
});

export default router;
