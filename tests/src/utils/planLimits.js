import { httpError } from './errors.js';
import { Subscription } from '../modules/platform/subscription.model.js';
import { Membership } from '../modules/users/membership.model.js';
import { Borrower } from '../modules/borrowers/borrower.model.js';
import { Loan, OPEN_STATUS } from '../modules/loans/loan.model.js';

const COUNTERS = {
  maxUsers: { label: 'usuarios', count: (orgId) => Membership.countDocuments({ orgId, status: 'activa' }) },
  maxBorrowers: { label: 'deudores', count: () => Borrower.countDocuments({}) },
  maxActiveLoans: { label: 'préstamos activos', count: () => Loan.countDocuments({ status: { $in: ['solicitud', 'aprobado', ...OPEN_STATUS] } }) },
};

/** Lanza 402 si la organización llegó al límite de su plan. Sin suscripción o límite 0 = sin límite. */
export async function assertPlanLimit(org, key, adding = 1) {
  const sub = await Subscription.findOne({ orgId: org._id });
  const max = sub?.limitsSnapshot?.[key] ?? 0;
  if (!max) return;
  const current = await COUNTERS[key].count(org._id);
  if (current + adding > max) {
    throw httpError(402, 'PLAN_LIMIT_REACHED', `Tu plan permite hasta ${max} ${COUNTERS[key].label}. Mejora tu plan para agregar más.`, { limit: key, max, current });
  }
}
