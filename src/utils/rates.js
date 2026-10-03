import Decimal from 'decimal.js';

// Cuántos períodos tiene un año según la periodicidad.
// Semanal usa 365/7 (52,14) para que la conversión coincida con cuotas cada 7 días.
// Quincenal son 24 porque las fechas van por medio mes (ver utils/dates.js).
export const PERIODS_PER_YEAR = { diaria: 365, semanal: 365 / 7, quincenal: 24, mensual: 12, anual: 1 };
export const RATE_BASES = Object.keys(PERIODS_PER_YEAR);
export const FREQUENCIES = ['diaria', 'semanal', 'quincenal', 'mensual'];

const ppy = (basis) => {
  const n = PERIODS_PER_YEAR[basis];
  if (!n) throw new Error(`Periodicidad desconocida: ${basis}`);
  return n;
};

/** Tasa efectiva anual (%) a partir de la tasa pactada. */
export function toEffectiveAnnual(rate, basis, kind = 'efectiva', frequency = 'mensual') {
  const r = new Decimal(rate).div(100);
  if (basis === 'anual') {
    if (kind === 'efectiva') return r.mul(100);
    // nominal anual capitalizable en la frecuencia de pago
    const n = ppy(frequency);
    return r.div(n).plus(1).pow(n).minus(1).mul(100);
  }
  // tasa periódica (mensual, quincenal...) tratada como efectiva del período
  return r.plus(1).pow(ppy(basis)).minus(1).mul(100);
}

/** Tasa efectiva (%) para un período de la periodicidad indicada. */
export function effectiveForPeriod(rate, basis, kind, targetBasis, frequency = 'mensual') {
  if (basis === targetBasis && (basis !== 'anual' || kind === 'efectiva')) return new Decimal(rate);
  if (basis === 'anual' && kind === 'nominal' && targetBasis === frequency) {
    return new Decimal(rate).div(ppy(frequency));
  }
  const ea = toEffectiveAnnual(rate, basis, kind, frequency).div(100);
  return ea.plus(1).pow(new Decimal(1).div(ppy(targetBasis))).minus(1).mul(100);
}

/** Devuelve las tres tasas que guarda el préstamo, como strings con 6 decimales. */
export function deriveRates({ rate, rateBasis, rateKind, frequency }) {
  return {
    ratePerPeriod: effectiveForPeriod(rate, rateBasis, rateKind, frequency, frequency).toFixed(6),
    rateMonthly: effectiveForPeriod(rate, rateBasis, rateKind, 'mensual', frequency).toFixed(6),
    rateAnnual: toEffectiveAnnual(rate, rateBasis, rateKind, frequency).toFixed(6),
  };
}
