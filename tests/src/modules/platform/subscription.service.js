import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { httpError } from '../../utils/errors.js';
import { Plan, CYCLE_MONTHS } from './plan.model.js';
import { Subscription } from './subscription.model.js';
import { SubscriptionPayment } from './subscriptionPayment.model.js';
import { Organization } from '../organizations/organization.model.js';

dayjs.extend(utc);

export const GRACE_DAYS = 5;
export const EXPIRED_REASON = 'suscripcion_vencida';

const addMonths = (date, months) => dayjs.utc(date).add(months, 'month').toDate();
const addDays = (date, days) => dayjs.utc(date).add(days, 'day').toDate();

const snapshot = (plan) => ({
  maxUsers: plan.limits?.maxUsers ?? 0,
  maxBorrowers: plan.limits?.maxBorrowers ?? 0,
  maxActiveLoans: plan.limits?.maxActiveLoans ?? 0,
});

/** Si la org estaba en solo lectura por falta de pago, la reactiva. Las suspensiones manuales no se tocan. */
async function reactivateOrgs(sub, session) {
  if (!sub.orgId) return;
  await Organization.updateOne(
    { _id: sub.orgId, status: 'solo_lectura', statusReason: EXPIRED_REASON },
    { $set: { status: 'activa', statusReason: null, statusChangedAt: new Date() } },
    { session },
  );
}

/** Crea o actualiza la suscripción de un cliente. trialDays > 0 deja un período de prueba. */
export async function upsertSubscription({ tenantAccountId, planId, trialDays = 0, session }) {
  const plan = await Plan.findById(planId).session(session);
  if (!plan?.isActive) throw httpError(404, 'PLAN_NOT_FOUND', 'Plan no encontrado o inactivo');

  let sub = await Subscription.findOne({ tenantAccountId }).session(session);
  const now = new Date();
  if (!sub) {
    sub = new Subscription({
      tenantAccountId,
      planId: plan._id,
      status: trialDays > 0 ? 'prueba' : 'vencida',
      currentPeriodStart: now,
      currentPeriodEnd: trialDays > 0 ? addDays(now, trialDays) : now,
      graceUntil: trialDays > 0 ? addDays(now, trialDays) : now,
    });
  } else {
    sub.planId = plan._id;
  }
  sub.limitsSnapshot = snapshot(plan);
  await sub.save({ session });
  return sub;
}

/**
 * Registra un pago y extiende el período: si sigue vigente, suma desde el fin actual;
 * si ya venció, arranca desde hoy.
 */
export async function registerSubscriptionPayment({ subscription, amount, method, reference, periods = 1, paidAt = new Date(), notes, adminId, session }) {
  const plan = await Plan.findById(subscription.planId).session(session);
  const months = CYCLE_MONTHS[plan.billingCycle] * periods;
  const stillValid = ['activa', 'prueba', 'en_gracia'].includes(subscription.status) && subscription.currentPeriodEnd > new Date();
  const periodFrom = stillValid ? subscription.currentPeriodEnd : new Date();
  const periodTo = addMonths(periodFrom, months);

  const [payment] = await SubscriptionPayment.create([{
    subscriptionId: subscription._id,
    tenantAccountId: subscription.tenantAccountId,
    planId: plan._id,
    amount: amount ?? plan.price * periods,
    currency: plan.currency,
    method,
    reference,
    periods,
    periodFrom,
    periodTo,
    paidAt,
    registeredBy: adminId,
    notes,
  }], { session, ordered: true });

  if (!stillValid) subscription.currentPeriodStart = periodFrom;
  subscription.currentPeriodEnd = periodTo;
  subscription.graceUntil = addDays(periodTo, GRACE_DAYS);
  subscription.status = 'activa';
  subscription.limitsSnapshot = snapshot(plan);
  await subscription.save({ session });
  await reactivateOrgs(subscription, session);
  return payment;
}

/** Job diario: pasa a gracia lo vencido y a solo lectura lo que agotó la gracia. */
export async function runSubscriptionCheck(now = new Date()) {
  const toGrace = await Subscription.updateMany(
    { status: { $in: ['activa', 'prueba'] }, currentPeriodEnd: { $lte: now } },
    { $set: { status: 'en_gracia' } },
  );

  const expired = await Subscription.find({ status: 'en_gracia', graceUntil: { $lte: now } });
  for (const sub of expired) {
    sub.status = 'vencida';
    await sub.save();
    if (sub.orgId) {
      await Organization.updateOne(
        { _id: sub.orgId, status: 'activa' },
        { $set: { status: 'solo_lectura', statusReason: EXPIRED_REASON, statusChangedAt: now } },
      );
    }
  }
  return { enGracia: toGrace.modifiedCount, vencidas: expired.length };
}
