import { Router } from 'express';
import dayjs from 'dayjs';
import { can } from '../../middlewares/permissions.js';
import { Loan, OPEN_STATUS } from '../loans/loan.model.js';
import { Installment } from '../loans/installment.model.js';
import { Payment } from '../payments/payment.model.js';
import { Borrower } from '../borrowers/borrower.model.js';

const router = Router();

/** Tablero de la organización (requiere contexto de la organización). Lo usan la app y el MCP. */
export async function computeDashboard() {
  const now = new Date();
  const today = dayjs(now).startOf('day').toDate();
  const in7 = dayjs(now).add(7, 'day').endOf('day').toDate();
  const monthStart = dayjs(now).startOf('month').toDate();

  const [byStatus, aging, monthPayments, monthDisbursed, borrowers, upcoming, overdue, recentPayments] = await Promise.all([
    Loan.aggregate([{ $group: {
      _id: '$status', count: { $sum: 1 }, principal: { $sum: '$principal' },
      balancePrincipal: { $sum: '$balancePrincipal' }, balanceInterest: { $sum: '$balanceInterest' }, balanceLateInterest: { $sum: '$balanceLateInterest' },
    } }]),
    Loan.aggregate([
      { $match: { status: { $in: OPEN_STATUS } } },
      { $group: { _id: '$agingBucket', count: { $sum: 1 }, balance: { $sum: '$balancePrincipal' } } },
    ]),
    // Incluye reversos (montos negativos) para que el total sea neto
    Payment.aggregate([
      { $match: { paidAt: { $gte: monthStart } } },
      { $group: {
        _id: null, total: { $sum: '$amount' }, principal: { $sum: '$appliedPrincipal' },
        interest: { $sum: '$appliedInterest' }, lateInterest: { $sum: '$appliedLateInterest' }, fees: { $sum: '$appliedFees' },
        count: { $sum: { $cond: ['$isReversal', 0, 1] } },
      } },
    ]),
    Loan.aggregate([
      { $match: { disbursementDate: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$principal' }, count: { $sum: 1 } } },
    ]),
    Borrower.countDocuments({ status: 'activo' }),
    Installment.find({ status: { $in: ['pendiente', 'parcial'] }, dueDate: { $gte: today, $lte: in7 } })
      .sort({ dueDate: 1 }).limit(15)
      .populate({ path: 'loanId', select: 'loanNumber currency status borrowerId', populate: { path: 'borrowerId', select: 'firstName lastName phone' } }),
    Loan.find({ status: 'en_mora' }).sort({ daysPastDue: -1 }).limit(10)
      .populate('borrowerId', 'firstName lastName phone'),
    Payment.find({}).sort({ paidAt: -1 }).limit(8)
      .populate('borrowerId', 'firstName lastName').populate('loanId', 'loanNumber'),
  ]);

  const statusMap = Object.fromEntries(byStatus.map((s) => [s._id, s]));
  const open = OPEN_STATUS.map((s) => statusMap[s]).filter(Boolean);
  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] ?? 0), 0);
  const mp = monthPayments[0] ?? { total: 0, principal: 0, interest: 0, lateInterest: 0, fees: 0, count: 0 };

  return {
    portfolio: {
      activeLoans: sum(open, 'count'),
      principalLent: sum(open, 'principal'),
      balancePrincipal: sum(open, 'balancePrincipal'),
      interestDue: sum(open, 'balanceInterest'),
      lateInterestDue: sum(open, 'balanceLateInterest'),
      overdueLoans: statusMap.en_mora?.count ?? 0,
      overdueBalance: statusMap.en_mora?.balancePrincipal ?? 0,
      paidOffLoans: statusMap.pagado?.count ?? 0,
      pendingDisbursement: (statusMap.solicitud?.count ?? 0) + (statusMap.aprobado?.count ?? 0),
      activeBorrowers: borrowers,
    },
    month: {
      collected: mp.total,
      collectedPrincipal: mp.principal,
      collectedInterest: mp.interest + mp.lateInterest,
      collectedFees: mp.fees,
      payments: mp.count,
      disbursed: monthDisbursed[0]?.total ?? 0,
      disbursedLoans: monthDisbursed[0]?.count ?? 0,
    },
    aging: Object.fromEntries(aging.map((a) => [a._id, { count: a.count, balance: a.balance }])),
    upcoming: upcoming.filter((i) => i.loanId && OPEN_STATUS.includes(i.loanId.status)),
    overdue,
    recentPayments,
  };
}

router.get('/', can('loan.read'), async (_req, res) => {
  res.json(await computeDashboard());
});

export default router;
