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

export const borrowerFields = z.object(fields);

/** Crea un deudor (requiere contexto de la organización). Lo usan la app y el MCP. */
export async function createBorrower(org, body) {
  await assertPlanLimit(org, 'maxBorrowers');
  const code = await nextSeq(org._id, 'borrower');
  return Borrower.create({ ...body, code: `C${code}`, docNumberHash: documentHash(org._id, body.docType, body.docNumber) });
}

router.post('/', can('borrower.create'), validate({ body: borrowerFields }), async (req, res) => {
  res.status(201).json(await createBorrower(req.org, req.valid.body));
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

export default router;
