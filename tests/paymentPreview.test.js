import { describe, it, expect, beforeAll, vi } from 'vitest';
import mongoose from 'mongoose';

// La simulación usa la misma lógica que registrar pero no guarda nada.
const saved = { installments: 0, loan: 0, payments: 0 };
let state;
const sess = (v) => ({ session: () => Promise.resolve(v) });

vi.mock('../src/db/withTransaction.js', () => ({ withTransaction: async (fn) => fn({}) }));
vi.mock('../src/modules/cash/cash.service.js', () => ({ assertCashOpen: async () => {} }));
vi.mock('../src/modules/counters/counter.model.js', () => ({ nextSeq: async () => '000099' }));
vi.mock('../src/modules/loans/loan.service.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    getInstallments: async () => state.insts,
    saveModified: async (docs) => { saved.installments += docs.length; },
    createInstallments: async (_l, rows) => rows.map((r) => ({ ...r })),
    applyReschedule: async (_l, insts) => insts,
  };
});

let previewPayment, Loan, Installment, Payment, PaymentAllocation, buildSchedule, deriveRates;
beforeAll(async () => {
  Object.assign(process.env, { MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 't' });
  ({ previewPayment } = await import('../src/modules/payments/payment.service.js'));
  ({ Loan } = await import('../src/modules/loans/loan.model.js'));
  ({ Installment } = await import('../src/modules/loans/installment.model.js'));
  ({ Payment } = await import('../src/modules/payments/payment.model.js'));
  ({ PaymentAllocation } = await import('../src/modules/payments/paymentAllocation.model.js'));
  ({ buildSchedule } = await import('../src/modules/loans/schedule.js'));
  ({ deriveRates } = await import('../src/utils/rates.js'));

  const loan = new Loan({ orgId: new mongoose.Types.ObjectId(), loanNumber: 'P1', borrowerId: new mongoose.Types.ObjectId(), status: 'al_dia', principal: 20_000_000, rate: '10', rateBasis: 'mensual', frequency: 'mensual', amortization: 'interes_simple', termCount: 4, disbursementDate: new Date('2026-10-05T12:00:00Z') });
  Object.assign(loan, deriveRates({ rate: '10', rateBasis: 'mensual', rateKind: 'efectiva', frequency: 'mensual' }));
  loan.balancePrincipal = loan.principal;
  loan.save = async () => { saved.loan += 1; };
  const rows = buildSchedule({ principal: loan.principal, ratePerPeriod: loan.ratePerPeriod, amortization: 'interes_simple', termCount: 4, firstDueDate: new Date('2026-11-05T12:00:00Z'), frequency: 'mensual' });
  state = { loan, insts: rows.map((r) => new Installment({ ...r, orgId: loan.orgId, loanId: loan._id })) };

  vi.spyOn(Payment, 'findOne').mockReturnValue(sess(null));
  vi.spyOn(Loan, 'findById').mockReturnValue(sess(state.loan));
  vi.spyOn(Payment, 'create').mockImplementation(async ([d]) => { saved.payments += 1; return [{ ...d, _id: new mongoose.Types.ObjectId() }]; });
  vi.spyOn(PaymentAllocation, 'create').mockResolvedValue([]);
});

describe('simular pago', () => {
  it('devuelve cómo se aplica y cómo queda, sin guardar cuotas ni préstamo', async () => {
    const p = await previewPayment({ loanId: state.loan._id, amount: 4_000_000, method: 'efectivo', cashAccountId: new mongoose.Types.ObjectId(), paidAt: new Date('2026-10-05T12:00:00Z'), applyTo: 'cuotas', targetNumbers: [1, 2], components: ['interes'] });
    expect(p.totals.interes).toBe(4_000_000);
    expect(p.totals.capital).toBe(0);
    expect(p.byInstallment.map((x) => [x.number, x.interes])).toEqual([[1, 2_000_000], [2, 2_000_000]]);
    expect(p.loanAfter.balancePrincipal).toBe(20_000_000);
    expect(p.schedule).toHaveLength(4);
    expect(saved.installments).toBe(0);
    expect(saved.loan).toBe(0);
  });
});
