import { describe, it, expect, beforeAll, vi } from 'vitest';
import mongoose from 'mongoose';

let lf, Borrower;
beforeAll(async () => {
  Object.assign(process.env, { MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 't' });
  lf = await import('../src/utils/listFilters.js');
  ({ Borrower } = await import('../src/modules/borrowers/borrower.model.js'));
});

describe('filtros de listados', () => {
  it('préstamos: búsqueda, rangos, mora y orden', async () => {
    const bid = new mongoose.Types.ObjectId();
    vi.spyOn(Borrower, 'find').mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [{ _id: bid }] }) }) });
    const q = lf.loanQuery.parse({ q: 'juan', minDpd: '30', from: '2026-01-01', to: '2026-01-31', minPrincipal: '100000', sort: 'mora', lendingRegime: 'informal' });
    const { filter, sort } = await lf.buildLoanFilter(q);
    expect(filter.daysPastDue).toEqual({ $gte: 30 });
    expect(filter.lendingRegime).toBe('informal');
    expect(filter.principal).toEqual({ $gte: 100000 });
    expect(filter.disbursementDate.$lte.toISOString()).toBe('2026-01-31T23:59:59.999Z');
    expect(filter.$or[1].borrowerId.$in).toEqual([bid]);
    expect(sort).toEqual({ daysPastDue: -1, createdAt: -1 });
  });

  it('pagos: tipo, montos e ids convertidos para aggregate', async () => {
    const cash = new mongoose.Types.ObjectId().toString();
    const { filter, sort } = await lf.buildPaymentFilter(lf.paymentQuery.parse({ kind: 'reversos', cashAccountId: cash, minAmount: '500', maxAmount: '900', sort: 'mayor' }));
    expect(filter.isReversal).toBe(true);
    expect(filter.cashAccountId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(filter.amount).toEqual({ $gte: 500, $lte: 900 });
    expect(sort).toEqual({ amount: -1 });
  });

  it('deudores: ciudad sin importar mayúsculas y calificación', async () => {
    const { filter } = await lf.buildBorrowerFilter(lf.borrowerQuery.parse({ city: 'carta', riskRating: 'C' }));
    expect(filter.city.test('Cartagena')).toBe(true);
    expect(filter.riskRating).toBe('C');
  });
});
