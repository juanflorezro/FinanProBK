import Decimal from 'decimal.js';

// El dinero se guarda como entero en centavos (ver db/types.js → money()).
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const toMinor = (value, decimals = 2) =>
  new Decimal(value).mul(10 ** decimals).toDecimalPlaces(0).toNumber();

export const fromMinor = (minor, decimals = 2) =>
  new Decimal(minor).div(10 ** decimals).toFixed(decimals);

/** Interés de un período: saldo (centavos) * tasa (%) → centavos redondeados. */
export const interestFor = (balanceMinor, ratePercent) =>
  new Decimal(balanceMinor).mul(ratePercent).div(100).toDecimalPlaces(0).toNumber();

/** Tasa periódica efectiva → anual efectiva (informativo). Mensual: periodsPerYear = 12 */
export const toAnnual = (ratePercent, periodsPerYear) =>
  new Decimal(1).plus(new Decimal(ratePercent).div(100)).pow(periodsPerYear).minus(1).mul(100).toFixed(4);

/** Anual efectiva → tasa periódica efectiva. */
export const fromAnnual = (annualPercent, periodsPerYear) =>
  new Decimal(1).plus(new Decimal(annualPercent).div(100)).pow(new Decimal(1).div(periodsPerYear)).minus(1).mul(100).toFixed(6);
