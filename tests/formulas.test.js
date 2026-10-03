import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';

let r, buildSchedule, lateInterestFor, accrueLateInterest, addPeriods, Installment;

beforeAll(async () => {
  Object.assign(process.env, {
    MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 'test',
  });
  r = await import('../src/utils/rates.js');
  ({ buildSchedule, lateInterestFor } = await import('../src/modules/loans/schedule.js'));
  ({ accrueLateInterest } = await import('../src/modules/loans/loan.logic.js'));
  ({ addPeriods } = await import('../src/utils/dates.js'));
  ({ Installment } = await import('../src/modules/loans/installment.model.js'));
});

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

describe('conversión de tasas', () => {
  it('2 % mensual = 26,824 % EA', () => {
    expect(r.toEffectiveAnnual('2', 'mensual').toFixed(3)).toBe('26.824');
  });
  it('29,66 % EA = 2,1881 % mensual', () => {
    expect(r.effectiveForPeriod('29.66', 'anual', 'efectiva', 'mensual').toFixed(4)).toBe('2.1881');
  });
  it('24 % nominal anual pagando quincenal = 1 % por quincena', () => {
    expect(r.deriveRates({ rate: '24', rateBasis: 'anual', rateKind: 'nominal', frequency: 'quincenal' }).ratePerPeriod).toBe('1.000000');
  });
  it('3 % mensual con cuotas quincenales = 1,4889 % por quincena (equivalente, no 1,5 %)', () => {
    expect(r.deriveRates({ rate: '3', rateBasis: 'mensual', rateKind: 'efectiva', frequency: 'quincenal' }).ratePerPeriod).toBe('1.488916');
  });
  it('20 % mensual = 791,61 % EA', () => {
    expect(r.toEffectiveAnnual('20', 'mensual').toFixed(2)).toBe('791.61');
  });
});

describe('fórmulas de cuotas', () => {
  it('cuota fija: 1.000.000 al 2 % mensual en 12 cuotas = 94.559,60', () => {
    const s = buildSchedule({ principal: 100_000_000, ratePerPeriod: '2', amortization: 'frances', termCount: 12, firstDueDate: D('2026-11-01'), frequency: 'mensual' });
    expect(s[0].principalDue + s[0].interestDue).toBe(9_455_960);
    expect(s[0].interestDue).toBe(2_000_000); // 1.000.000 × 2 %
    expect(s.at(-1).closingBalance).toBe(0);
  });
  it('interés simple: interés siempre sobre el capital inicial', () => {
    const s = buildSchedule({ principal: 120_000_000, ratePerPeriod: '5', amortization: 'interes_simple', termCount: 4, firstDueDate: D('2026-11-01'), frequency: 'mensual' });
    expect(s.map((x) => x.interestDue)).toEqual([6_000_000, 6_000_000, 6_000_000, 6_000_000]);
    expect(s.map((x) => x.principalDue)).toEqual([30_000_000, 30_000_000, 30_000_000, 30_000_000]);
  });
  it('quincenal: 24 fechas al año, cada medio mes', () => {
    expect([0, 1, 2, 3].map((n) => iso(addPeriods(D('2026-10-05'), 'quincenal', n)))).toEqual(['2026-10-05', '2026-10-20', '2026-11-05', '2026-11-20']);
    expect(iso(addPeriods(D('2026-10-05'), 'quincenal', 24))).toBe('2027-10-05');
  });
});

describe('mora', () => {
  it('3 % mensual de mora sobre 100.000 durante 10 días = 972,27', () => {
    const daily = r.effectiveForPeriod('3', 'mensual', 'efectiva', 'diaria');
    expect(lateInterestFor({ overdueBase: 10_000_000, dailyRate: daily, days: 10 })).toBe(97_227);
  });
  it('por defecto se cobra solo sobre capital vencido, no sobre intereses', () => {
    const loan = { lateRate: '3', lateRateBasis: 'mensual', frequency: 'mensual', graceDays: 0 };
    const mk = () => new Installment({ orgId: new mongoose.Types.ObjectId(), loanId: new mongoose.Types.ObjectId(), number: 1, dueDate: D('2026-09-01'), principalDue: 10_000_000, interestDue: 2_000_000 });
    const a = mk(); accrueLateInterest(loan, [a], D('2026-09-11'));
    const b = mk(); accrueLateInterest({ ...loan, lateInterestBase: 'capital_e_interes' }, [b], D('2026-09-11'));
    expect(a.lateInterestAccrued).toBe(97_227);
    expect(b.lateInterestAccrued).toBeGreaterThan(a.lateInterestAccrued);
  });
});
