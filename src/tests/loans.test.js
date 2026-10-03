import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';

let buildSchedule, allocatePayment, recomputeSummary, accrueLateInterest, nextRollingRows, rescheduleRows, Installment, Loan;

beforeAll(async () => {
  Object.assign(process.env, {
    MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32), GOOGLE_CLIENT_ID: 'test',
  });
  ({ buildSchedule } = await import('../src/modules/loans/schedule.js'));
  ({ allocatePayment } = await import('../src/modules/payments/allocation.js'));
  ({ recomputeSummary, accrueLateInterest, nextRollingRows, rescheduleRows } = await import('../src/modules/loans/loan.logic.js'));
  ({ Installment } = await import('../src/modules/loans/installment.model.js'));
  ({ Loan } = await import('../src/modules/loans/loan.model.js'));
});

const oid = () => new mongoose.Types.ObjectId();
const D = (s) => new Date(`${s}T00:00:00Z`);
const M = 100; // 1 peso = 100 centavos

function makeLoan(extra) {
  const loan = new Loan({ orgId: oid(), loanNumber: 'T1', borrowerId: oid(), status: 'al_dia', ...extra });
  loan.validateSync(); // ejecuta cálculo de tasas
  Object.assign(loan, require_rates(loan));
  loan.balancePrincipal = loan.principal;
  return loan;
}
// pre('validate') es async en el modelo; aquí calculamos las tasas igual que el hook
import { deriveRates } from '../src/utils/rates.js';
const require_rates = (l) => deriveRates({ rate: l.rate, rateBasis: l.rateBasis, rateKind: l.rateKind, frequency: l.frequency });

const toDocs = (loan, rows) => rows.map((r) => new Installment({ ...r, orgId: loan.orgId, loanId: loan._id }));

describe('plan de cuotas', () => {
  it('francés: cuota fija y saldo final en cero', () => {
    const rows = buildSchedule({ principal: 1_000_000 * M, ratePerPeriod: '2', amortization: 'frances', termCount: 12, firstDueDate: D('2026-11-02'), frequency: 'mensual' });
    expect(rows).toHaveLength(12);
    expect(rows.at(-1).closingBalance).toBe(0);
    expect(rows.reduce((a, r) => a + r.principalDue, 0)).toBe(1_000_000 * M);
    const cuotas = rows.slice(0, -1).map((r) => r.principalDue + r.interestDue);
    expect(new Set(cuotas).size).toBe(1);
    expect(cuotas[0]).toBe(9_455_960); // $94.559,60
  });

  it('alemán: capital fijo', () => {
    const rows = buildSchedule({ principal: 1_200_000 * M, ratePerPeriod: '3', amortization: 'aleman', termCount: 12, firstDueDate: D('2026-11-02'), frequency: 'mensual' });
    expect(rows[0].principalDue).toBe(100_000 * M);
    expect(rows[0].interestDue).toBe(36_000 * M);
    expect(rows[11].interestDue).toBe(3_000 * M);
  });

  it('abonos libres: una cuota de solo interés', () => {
    const rows = buildSchedule({ principal: 1_000_000 * M, ratePerPeriod: '20', amortization: 'abonos_libres', firstDueDate: D('2026-11-05'), frequency: 'mensual' });
    expect(rows).toEqual([expect.objectContaining({ principalDue: 0, interestDue: 200_000 * M })]);
  });

  it('mensual respeta fin de mes', () => {
    const rows = buildSchedule({ principal: 300 * M, ratePerPeriod: '0', amortization: 'aleman', termCount: 3, firstDueDate: D('2026-01-31'), frequency: 'mensual' });
    expect(rows.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
});

describe('pagos', () => {
  it('ejemplo informal: 1.000.000 al 20 % mensual, paga interés y luego abona capital', () => {
    const loan = makeLoan({ principal: 1_000_000 * M, rate: '20', rateBasis: 'mensual', amortization: 'abonos_libres' });
    let inst = toDocs(loan, buildSchedule({ principal: loan.principal, ratePerPeriod: loan.ratePerPeriod, amortization: 'abonos_libres', firstDueDate: D('2026-09-05'), frequency: 'mensual' }));

    // 5 sep: paga 200.000 de interés
    let r = allocatePayment({ loan, installments: inst, amount: 200_000 * M, asOf: D('2026-09-05') });
    loan.balancePrincipal -= r.totals.capital;
    expect(r.totals).toMatchObject({ interes: 200_000 * M, capital: 0 });
    recomputeSummary(loan, inst, D('2026-09-05'));
    expect(inst[0].status).toBe('pagada');

    // al pasar la fecha se genera la cuota de octubre
    inst = [...inst, ...toDocs(loan, nextRollingRows(loan, inst, D('2026-09-06')))];
    expect(inst).toHaveLength(2);
    expect(inst[1].interestDue).toBe(200_000 * M);

    // 5 oct: paga 700.000 → 200.000 interés + 500.000 capital
    r = allocatePayment({ loan, installments: inst, amount: 700_000 * M, asOf: D('2026-10-05') });
    loan.balancePrincipal -= r.totals.capital;
    expect(r.totals).toMatchObject({ interes: 200_000 * M, capital: 500_000 * M });
    expect(loan.balancePrincipal).toBe(500_000 * M);

    // la cuota de noviembre ya cobra interés sobre 500.000
    recomputeSummary(loan, inst, D('2026-10-06'));
    const nov = nextRollingRows(loan, inst, D('2026-10-06'));
    expect(nov[0].interestDue).toBe(100_000 * M);
  });

  it('mora: cascada mora → interés → capital y estado en_mora', () => {
    const loan = makeLoan({ principal: 1_000_000 * M, rate: '2', rateBasis: 'mensual', amortization: 'frances', termCount: 3, lateRate: '3', lateRateBasis: 'mensual' });
    const inst = toDocs(loan, buildSchedule({ principal: loan.principal, ratePerPeriod: loan.ratePerPeriod, amortization: 'frances', termCount: 3, firstDueDate: D('2026-09-01'), frequency: 'mensual' }));
    const asOf = D('2026-09-11'); // 10 días vencida
    accrueLateInterest(loan, inst, asOf);
    expect(inst[0].lateInterestAccrued).toBeGreaterThan(0);
    recomputeSummary(loan, inst, asOf);
    expect(loan.status).toBe('en_mora');
    expect(loan.daysPastDue).toBe(10);

    const late = inst[0].lateInterestAccrued;
    const r = allocatePayment({ loan, installments: inst, amount: late + 5_000 * M, asOf });
    expect(r.allocations.map((a) => a.component)).toEqual(['mora', 'interes']);
    expect(r.totals.mora).toBe(late);
  });

  it('abono extraordinario en plan fijo pide replanificar y reduce la cuota', () => {
    const loan = makeLoan({ principal: 1_200_000 * M, rate: '2', rateBasis: 'mensual', amortization: 'frances', termCount: 12 });
    const inst = toDocs(loan, buildSchedule({ principal: loan.principal, ratePerPeriod: loan.ratePerPeriod, amortization: 'frances', termCount: 12, firstDueDate: D('2026-11-01'), frequency: 'mensual' }));
    const before = inst[0].principalDue + inst[0].interestDue;
    const r = allocatePayment({ loan, installments: inst, amount: 600_000 * M, asOf: D('2026-10-15'), excessMode: 'capital' });
    expect(r.needsReschedule).toBe(true);
    loan.balancePrincipal -= r.totals.capital;
    const { cancel, rows } = rescheduleRows(loan, inst, D('2026-10-15'));
    expect(cancel).toHaveLength(12);
    expect(rows).toHaveLength(12);
    expect(rows[0].principalDue + rows[0].interestDue).toBeLessThan(before);
  });

  it('pago mayor a la deuda deja saldo a favor y préstamo pagado', () => {
    const loan = makeLoan({ principal: 100 * M, rate: '10', rateBasis: 'mensual', amortization: 'solo_interes', termCount: 1 });
    const inst = toDocs(loan, buildSchedule({ principal: loan.principal, ratePerPeriod: loan.ratePerPeriod, amortization: 'solo_interes', termCount: 1, firstDueDate: D('2026-10-01'), frequency: 'mensual' }));
    const r = allocatePayment({ loan, installments: inst, amount: 150 * M, asOf: D('2026-10-01') });
    loan.balancePrincipal -= r.totals.capital;
    expect(r.unapplied).toBe(40 * M);
    recomputeSummary(loan, inst, D('2026-10-01'));
    expect(loan.status).toBe('pagado');
  });
});
