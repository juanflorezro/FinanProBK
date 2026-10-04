import { Loan } from '../loans/loan.model.js';
import { Payment } from '../payments/payment.model.js';
import { getInstallments } from '../loans/loan.service.js';
import { sendMail } from '../../services/notifications/mailer.js';

// Piezas comunes del portal por empresa (/p/:slug) y del portal global (/portal).

export const VISIBLE = ['desembolsado', 'al_dia', 'en_mora', 'reestructurado', 'pagado', 'castigado'];
export const LOAN_SUMMARY = 'loanNumber principal currency status balancePrincipal balanceInterest balanceLateInterest balanceFees totalPaid daysPastDue nextDueDate nextDueAmount disbursementDate maturityDate amortization frequency termCount rate rateBasis rateAnnual closedAt';
const LOAN_DETAIL = `${LOAN_SUMMARY} lateRate lateRateBasis graceDays`;

/** Detalle de un préstamo para el deudor (requiere contexto de la organización). */
export async function loanDetail(loanId, borrowerId) {
  const loan = await Loan.findOne({ _id: loanId, borrowerId, status: { $in: VISIBLE } }).select(LOAN_DETAIL);
  if (!loan) return null;
  const [installments, payments] = await Promise.all([
    getInstallments(loan),
    Payment.find({ loanId: loan._id }).sort({ paidAt: -1 })
      .select('receiptNumber amount currency method paidAt status isReversal appliedPrincipal appliedInterest appliedLateInterest appliedFees unappliedAmount'),
  ]);
  return {
    loan,
    installments: installments.map((i) => ({
      _id: i._id, number: i.number, dueDate: i.dueDate, status: i.status, daysPastDue: i.daysPastDue,
      principalDue: i.principalDue, interestDue: i.interestDue, feesDue: i.feesDue, lateInterest: i.lateInterestAccrued,
      paid: i.principalPaid + i.interestPaid + i.feesPaid + i.lateInterestPaid, waived: i.waived, pending: i.pending,
    })),
    payments,
  };
}

export function sendPortalCodeMail({ to, firstName, code, minutes, issuer }) {
  const text = `${issuer}: tu código para consultar tus préstamos es ${code}. Vence en ${minutes} minutos. No lo compartas.`;
  return sendMail({
    to,
    subject: `Tu código de acceso: ${code}`,
    text,
    html: `<p>Hola${firstName ? ` ${firstName}` : ''},</p><p>Tu código para consultar tus préstamos en <strong>${issuer}</strong> es:</p><p style="font-size:30px;letter-spacing:8px;font-weight:bold">${code}</p><p>Vence en ${minutes} minutos. No lo compartas con nadie.</p>`,
  });
}
