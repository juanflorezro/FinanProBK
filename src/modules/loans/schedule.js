import Decimal from 'decimal.js';
import { addPeriods } from '../../utils/dates.js';

const round = (d) => d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

/**
 * Genera el plan de cuotas. Funciones puras: no tocan la base de datos.
 * Montos en centavos. ratePerPeriod en % efectivo por período (ej. "20").
 *
 * frances         cuota fija, interés sobre saldo
 * aleman          capital fijo, interés sobre saldo (cuota decreciente)
 * interes_simple  capital fijo, interés siempre sobre el capital inicial
 * solo_interes    paga interés cada período y todo el capital en la última
 * abonos_libres   genera solo la cuota de interés del período actual;
 *                 el capital se abona cuando el deudor quiera
 */
export function buildSchedule({
  principal,
  ratePerPeriod,
  amortization,
  termCount,
  firstDueDate,
  frequency,
  interestBase = 'saldo_capital',
  startNumber = 1,
  initialPrincipal,
}) {
  const P = new Decimal(principal);
  const i = new Decimal(ratePerPeriod).div(100);
  const P0 = new Decimal(initialPrincipal ?? principal);
  const due = (k) => addPeriods(firstDueDate, frequency, k);

  if (amortization === 'abonos_libres') {
    const base = interestBase === 'capital_inicial' ? P0 : P;
    return [{
      number: startNumber,
      dueDate: due(0),
      openingBalance: P.toNumber(),
      principalDue: 0,
      interestDue: round(base.mul(i)),
      closingBalance: P.toNumber(),
    }];
  }

  const n = termCount;
  if (!Number.isInteger(n) || n < 1) throw new Error('termCount debe ser un entero mayor a 0');

  const cuota = amortization === 'frances'
    ? round(i.isZero() ? P.div(n) : P.mul(i).div(new Decimal(1).minus(i.plus(1).pow(-n))))
    : null;
  const fixedPrincipal = P.div(n).floor();
  const rows = [];
  let balance = P;

  for (let k = 0; k < n; k++) {
    const last = k === n - 1;
    const opening = balance;
    const useInitial = amortization === 'interes_simple'
      || (interestBase === 'capital_inicial' && amortization !== 'frances');
    const interest = round((useInitial ? P0 : opening).mul(i));

    let principalDue;
    switch (amortization) {
      case 'frances':
        principalDue = last ? opening.toNumber() : Math.min(opening.toNumber(), cuota - interest);
        break;
      case 'aleman':
      case 'interes_simple':
        principalDue = last ? opening.toNumber() : fixedPrincipal.toNumber();
        break;
      case 'solo_interes':
        principalDue = last ? opening.toNumber() : 0;
        break;
      default:
        throw new Error(`Amortización desconocida: ${amortization}`);
    }

    balance = opening.minus(principalDue);
    rows.push({
      number: startNumber + k,
      dueDate: due(k),
      openingBalance: opening.toNumber(),
      principalDue,
      interestDue: interest,
      closingBalance: balance.toNumber(),
    });
  }
  return rows;
}

/** Interés de mora simple: base vencida * tasa diaria * días. */
export function lateInterestFor({ overdueBase, dailyRate, days }) {
  if (days <= 0 || overdueBase <= 0) return 0;
  return round(new Decimal(overdueBase).mul(new Decimal(dailyRate).div(100)).mul(days));
}
