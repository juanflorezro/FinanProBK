// Reparto de un pago (cascada). Puro: modifica las cuotas en memoria y devuelve el detalle.

export const DEFAULT_WATERFALL = ['mora', 'cargo', 'interes', 'capital'];

export const FIELDS = {
  mora: ['lateInterestAccrued', 'lateInterestPaid'],
  cargo: ['feesDue', 'feesPaid'],
  interes: ['interestDue', 'interestPaid'],
  capital: ['principalDue', 'principalPaid'],
};

/**
 * excessMode:
 *  'proximas_cuotas'  el sobrante paga las cuotas siguientes en orden
 *  'capital'          el sobrante va directo a capital (abono extraordinario)
 * Por defecto: abonos_libres → capital ; planes fijos → proximas_cuotas
 */
export function allocatePayment({ loan, installments, amount, asOf, waterfall = DEFAULT_WATERFALL, excessMode }) {
  let remaining = amount;
  let order = 0;
  const allocations = [];
  const totals = { mora: 0, cargo: 0, interes: 0, capital: 0 };

  const apply = (inst, component) => {
    if (remaining <= 0) return;
    const [dueF, paidF] = FIELDS[component];
    const take = Math.min(inst[dueF] - inst[paidF], remaining);
    if (take <= 0) return;
    inst[paidF] += take;
    remaining -= take;
    totals[component] += take;
    allocations.push({ installmentId: inst._id, component, amount: take, order: ++order });
  };

  const open = installments
    .filter((i) => !['pagada', 'anulada', 'condonada'].includes(i.status))
    .sort((a, b) => a.number - b.number);
  const exigible = open.filter((i) => i.dueDate <= asOf);
  const future = open.filter((i) => i.dueDate > asOf);

  // 1. Lo vencido, cuota por cuota, en el orden de la cascada
  for (const inst of exigible) for (const c of waterfall) apply(inst, c);

  // 2. El sobrante
  const mode = excessMode ?? (loan.amortization === 'abonos_libres' ? 'capital' : 'proximas_cuotas');
  let extraordinaryCapital = 0;

  if (mode === 'proximas_cuotas') {
    for (const inst of future) for (const c of waterfall) apply(inst, c);
  } else {
    // abonos libres: primero el interés del período en curso; planes fijos: no se adelanta interés futuro
    if (loan.amortization === 'abonos_libres' && future[0]) {
      for (const c of waterfall) if (c !== 'capital') apply(future[0], c);
    }
    const pendingInstallmentPrincipal = open.reduce((a, i) => a + (i.principalDue - i.principalPaid), 0);
    const freeCapital = loan.balancePrincipal - totals.capital - pendingInstallmentPrincipal;
    // en planes fijos el capital libre es el de las cuotas futuras (se replanifica)
    const capitalRoom = loan.amortization === 'abonos_libres'
      ? loan.balancePrincipal - totals.capital
      : Math.max(freeCapital, 0) + future.reduce((a, i) => a + (i.principalDue - i.principalPaid), 0);
    extraordinaryCapital = Math.min(remaining, Math.max(capitalRoom, 0));
    if (extraordinaryCapital > 0) {
      remaining -= extraordinaryCapital;
      totals.capital += extraordinaryCapital;
      allocations.push({ installmentId: null, component: 'capital', amount: extraordinaryCapital, order: ++order });
    }
  }

  // 3. Lo que sobre queda como saldo a favor
  const unapplied = remaining;
  if (unapplied > 0) allocations.push({ installmentId: null, component: 'saldo_a_favor', amount: unapplied, order: ++order });

  return {
    allocations,
    totals,
    unapplied,
    needsReschedule: extraordinaryCapital > 0 && loan.amortization !== 'abonos_libres',
  };
}
