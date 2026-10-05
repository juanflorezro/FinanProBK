import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';

// Modalidades de pago profesionales: cuotas, intereses, capital (reducir cuota / plazo) y liquidación.
let buildSchedule, allocatePayment, rescheduleRows, computePayoff, prepareLiquidation, recomputeSummary, Installment, Loan, deriveRates;

beforeAll(async () => {
  Object.assign(process.env, { MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 't' });
  ({ buildSchedule } = await import('../src/modules/loans/schedule.js'));
  ({ allocatePayment } = await import('../src/modules/payments/allocation.js'));
  ({ rescheduleRows, computePayoff, prepareLiquidation, recomputeSummary } = await import('../src/modules/loans/loan.logic.js'));
  ({ Installment } = await import('../src/modules/loans/installment.model.js'));
  ({ Loan } = await import('../src/modules/loans/loan.model.js'));
  ({ deriveRates } = await import('../src/utils/rates.js'));
});

const oid = () => new mongoose.Types.ObjectId();
const D = (s) => new Date(`${s}T00:00:00Z`);
const M = 100;

function setup({ amortization = 'frances', termCount = 12, principal = 1_200_000 } = {}) {
  const loan = new Loan({ orgId: oid(), loanNumber: 'T1', borrowerId: oid(), status: 'al_dia', principal: principal * M, rate: '2', rateBasis: 'mensual', frequency: 'mensual', amortization, termCount, disbursementDate: D('2026-01-01') });
  Object.assign(loan, deriveRates({ rate: loan.rate, rateBasis: loan.rateBasis, rateKind: 'efectiva', frequency: 'mensual' }));
  loan.balancePrincipal = loan.principal;
  const rows = buildSchedule({ principal: loan.principal, ratePerPeriod: loan.ratePerPeriod, amortization, termCount, firstDueDate: D('2026-02-01'), frequency: 'mensual' });
  const insts = rows.map((r) => new Installment({ ...r, orgId: loan.orgId, loanId: loan._id }));
  return { loan, insts };
}

describe('aplicar pago a cuotas elegidas', () => {
  it('paga solo las cuotas indicadas, en orden de la cascada', () => {
    const { loan, insts } = setup();
    const cuota = insts[0].principalDue + insts[0].interestDue;
    const r = allocatePayment({ loan, installments: insts, amount: cuota, asOf: D('2026-01-15'), applyTo: 'cuotas', targetNumbers: [3] });
    expect(r.allocations.every((a) => String(a.installmentId) === String(insts[2]._id))).toBe(true);
    expect(insts[2].principalPaid + insts[2].interestPaid).toBe(cuota);
    expect(insts[0].principalPaid).toBe(0);
    expect(r.unapplied).toBe(0);
  });
});

describe('abono solo a intereses', () => {
  it('paga mora e interés vencido y el interés del período en curso, nunca capital', () => {
    const { loan, insts } = setup();
    insts[0].lateInterestAccrued = 5_000 * M;
    const r = allocatePayment({ loan, installments: insts, amount: 1_000_000 * M, asOf: D('2026-02-10'), applyTo: 'intereses' });
    expect(r.totals.capital).toBe(0);
    expect(r.totals.mora).toBe(5_000 * M);
    expect(r.totals.interes).toBe(insts[0].interestDue + insts[1].interestDue);
    expect(r.unapplied).toBeGreaterThan(0); // el servicio rechaza si sobra
  });
});

describe('abono extraordinario a capital (Ley 1555 de 2012)', () => {
  it('reducir cuota: mismo número de cuotas, cuota más baja', () => {
    const { loan, insts } = setup();
    const r = allocatePayment({ loan, installments: insts, amount: 300_000 * M, asOf: D('2026-01-15'), applyTo: 'capital' });
    expect(r.totals.capital).toBe(300_000 * M);
    expect(r.needsReschedule).toBe(true);
    loan.balancePrincipal -= r.totals.capital;
    const { cancel, rows } = rescheduleRows(loan, insts, D('2026-01-15'), 'reducir_cuota');
    expect(rows).toHaveLength(cancel.length);
    expect(rows[0].principalDue + rows[0].interestDue).toBeLessThan(insts[0].principalDue + insts[0].interestDue);
    expect(rows.reduce((a, x) => a + x.principalDue, 0)).toBe(900_000 * M);
  });

  it('reducir plazo: menos cuotas, cuota que no sube', () => {
    const { loan, insts } = setup();
    const old = insts[0].principalDue + insts[0].interestDue;
    loan.balancePrincipal -= 300_000 * M;
    const { cancel, rows } = rescheduleRows(loan, insts, D('2026-01-15'), 'reducir_plazo');
    expect(rows.length).toBeLessThan(cancel.length);
    expect(rows[0].principalDue + rows[0].interestDue).toBeLessThanOrEqual(old + 1);
    expect(rows.reduce((a, x) => a + x.principalDue, 0)).toBe(900_000 * M);
    expect(rows.at(-1).closingBalance).toBe(0);
  });

  it('capital fijo con reducir plazo conserva el abono a capital por cuota', () => {
    const { loan, insts } = setup({ amortization: 'aleman' });
    loan.balancePrincipal -= 300_000 * M; // 1.200.000 / 12 = 100.000 por cuota
    const { rows } = rescheduleRows(loan, insts, D('2026-01-15'), 'reducir_plazo');
    expect(rows).toHaveLength(9);
    expect(rows[0].principalDue).toBe(100_000 * M);
  });
});

describe('liquidación anticipada', () => {
  it('cobra interés solo por los días corridos del período en curso', () => {
    const { loan, insts } = setup();
    const p = computePayoff(loan, insts, D('2026-01-16')); // 15 de 31 días
    expect(p.principal).toBe(1_200_000 * M);
    expect(p.currentInterest).toBe(Math.round(insts[0].interestDue * 15 / 31));
    expect(p.total).toBe(p.principal + p.currentInterest);
  });

  it('suma lo vencido (mora, interés y capital) más el saldo', () => {
    const { loan, insts } = setup();
    insts[0].lateInterestAccrued = 2_000 * M;
    const p = computePayoff(loan, insts, D('2026-02-11'));
    expect(p.overdueInterest).toBe(insts[0].interestDue);
    expect(p.lateInterest).toBe(2_000 * M);
    expect(p.total).toBe(1_200_000 * M + insts[0].interestDue + 2_000 * M + p.currentInterest);
  });

  it('pagando el total el préstamo queda en cero y pagado', () => {
    const { loan, insts } = setup();
    const asOf = D('2026-02-11');
    const p = computePayoff(loan, insts, asOf);
    const cancelled = prepareLiquidation(loan, insts, asOf, p);
    expect(cancelled).toHaveLength(10);
    const r = allocatePayment({ loan, installments: insts, amount: p.total, asOf, excessMode: 'proximas_cuotas' });
    expect(r.unapplied).toBe(0);
    loan.balancePrincipal -= r.totals.capital;
    expect(loan.balancePrincipal).toBe(0);
    recomputeSummary(loan, insts, asOf);
    expect(loan.status).toBe('pagado');
  });
});
