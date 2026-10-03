import { Router } from 'express';
import dayjs from 'dayjs';
import { TenantAccount } from './tenantAccount.model.js';
import { Organization } from '../organizations/organization.model.js';
import { Subscription } from './subscription.model.js';
import { SubscriptionPayment } from './subscriptionPayment.model.js';
import { CYCLE_MONTHS } from './plan.model.js';

const router = Router();

const countBy = async (Model, field) => {
  const rows = await Model.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
};

router.get('/', async (_req, res) => {
  const now = new Date();
  const in7 = dayjs(now).add(7, 'day').toDate();
  const monthStart = dayjs(now).startOf('month').toDate();

  const [tenants, organizations, subscriptions, active, expiring, monthRevenue, recentPayments] = await Promise.all([
    countBy(TenantAccount, 'status'),
    countBy(Organization, 'status'),
    countBy(Subscription, 'status'),
    Subscription.find({ status: { $in: ['activa', 'en_gracia'] } }).populate('planId', 'price billingCycle currency'),
    Subscription.find({ status: { $in: ['activa', 'prueba', 'en_gracia'] }, currentPeriodEnd: { $lte: in7 } })
      .sort({ currentPeriodEnd: 1 }).limit(20)
      .populate('tenantAccountId', 'legalName contactEmail contactPhone')
      .populate('planId', 'name price'),
    SubscriptionPayment.aggregate([
      { $match: { status: 'confirmado', paidAt: { $gte: monthStart } } },
      { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    SubscriptionPayment.find({ status: 'confirmado' }).sort({ paidAt: -1 }).limit(10)
      .populate('tenantAccountId', 'legalName'),
  ]);

  // Ingreso mensual recurrente: precio del plan llevado a valor mensual
  const mrr = {};
  for (const s of active) {
    const p = s.planId;
    if (!p) continue;
    mrr[p.currency] = (mrr[p.currency] ?? 0) + Math.round(p.price / CYCLE_MONTHS[p.billingCycle]);
  }

  res.json({ tenants, organizations, subscriptions, mrr, monthRevenue, expiring, recentPayments });
});

export default router;
