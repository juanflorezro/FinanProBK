import { Loan, OPEN_STATUS } from '../modules/loans/loan.model.js';
import { refreshLoan } from '../modules/loans/loan.service.js';
import { runWithContext } from '../db/context.js';

/**
 * Job diario (correr de madrugada): causa mora, crea la cuota de interés
 * de los préstamos de abonos libres y actualiza estados y días de mora.
 * Conéctalo a agenda: agenda.define('daily-accrual', () => runDailyAccrual());
 *                     await agenda.every('0 2 * * *', 'daily-accrual', {}, { timezone: 'America/Bogota' });
 */
export async function runDailyAccrual(asOf = new Date()) {
  const orgIds = await Loan.distinct('orgId', { status: { $in: OPEN_STATUS } }).setOptions({ skipTenant: true });
  const result = { orgs: orgIds.length, loans: 0, errors: [] };

  for (const orgId of orgIds) {
    await runWithContext({ orgId, userId: null, system: true }, async () => {
      const loans = await Loan.find({ status: { $in: OPEN_STATUS } }).select('_id').lean();
      for (const { _id } of loans) {
        try {
          await refreshLoan(_id, asOf);
          result.loans += 1;
        } catch (err) {
          result.errors.push({ orgId: String(orgId), loanId: String(_id), error: err.message });
        }
      }
    });
  }
  return result;
}
