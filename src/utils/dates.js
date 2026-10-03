import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

const STEP = {
  diaria: [1, 'day'],
  semanal: [7, 'day'],
  mensual: [1, 'month'],
};

/** Fecha + n períodos. Siempre se calcula desde la fecha base para no arrastrar desfases de fin de mes. */
export function addPeriods(date, frequency, n) {
  // Quincenal = medio mes: 24 cuotas al año, igual que la tasa (5 → 20 → 5 del mes siguiente...)
  if (frequency === 'quincenal') {
    return dayjs.utc(date).add(Math.floor(n / 2), 'month').add((n % 2) * 15, 'day').toDate();
  }
  const step = STEP[frequency];
  if (!step) throw new Error(`Frecuencia desconocida: ${frequency}`);
  return dayjs.utc(date).add(step[0] * n, step[1]).toDate();
}

export const addDays = (date, n) => dayjs.utc(date).add(n, 'day').toDate();
export const startOfDay = (date) => dayjs.utc(date).startOf('day').toDate();
export const daysBetween = (from, to) =>
  Math.max(0, dayjs.utc(startOfDay(to)).diff(dayjs.utc(startOfDay(from)), 'day'));
