import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

const STEP = {
  diaria: [1, 'day'],
  semanal: [7, 'day'],
  quincenal: [15, 'day'],
  mensual: [1, 'month'],
};

/** Fecha + n períodos. Siempre se calcula desde la fecha base para no arrastrar desfases de fin de mes. */
export function addPeriods(date, frequency, n) {
  const step = STEP[frequency];
  if (!step) throw new Error(`Frecuencia desconocida: ${frequency}`);
  return dayjs.utc(date).add(step[0] * n, step[1]).toDate();
}

export const addDays = (date, n) => dayjs.utc(date).add(n, 'day').toDate();
export const startOfDay = (date) => dayjs.utc(date).startOf('day').toDate();
export const daysBetween = (from, to) =>
  Math.max(0, dayjs.utc(startOfDay(to)).diff(dayjs.utc(startOfDay(from)), 'day'));
