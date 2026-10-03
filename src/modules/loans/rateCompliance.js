import Decimal from 'decimal.js';
import { httpError } from '../../utils/errors.js';
import { toEffectiveAnnual } from '../../utils/rates.js';
import { RateCap } from '../platform/rateCap.model.js';

/**
 * Revisa la tasa contra el tope legal SOLO si la organización está acogida a la ley.
 * - No acogida → tasa libre (rateCapCheck: 'no_aplica').
 * - Acogida + política 'bloquear' → rechaza tasas por encima del tope.
 * - Acogida + política 'advertir' → exige acknowledgeRateCap: true y deja constancia.
 * Devuelve los campos a guardar en el préstamo.
 */
export async function checkRateCompliance({ org, loan, acknowledge, membershipId, at = new Date() }) {
  const cfg = org.settings?.legalRateCompliance;
  if (!cfg?.enabled) return { rateCapCheck: 'no_aplica' };

  const rateAnnual = toEffectiveAnnual(loan.rate, loan.rateBasis, loan.rateKind, loan.frequency);
  const cap = await RateCap.currentFor(org.country, cfg.modality ?? 'consumo', at);

  if (!cap) {
    if (cfg.policy === 'bloquear') {
      throw httpError(422, 'RATE_CAP_NOT_CONFIGURED', `No hay tasa máxima vigente cargada para ${org.country} (${cfg.modality}). Pide al administrador de la plataforma que la registre.`);
    }
    return { rateCapCheck: 'sin_tope_cargado' };
  }

  const max = new Decimal(cap.maxAnnualEffectiveRate);
  const base = { rateCapId: cap._id, rateCapEA: max.toFixed(4) };
  if (rateAnnual.lte(max)) return { ...base, rateCapCheck: 'dentro' };

  const details = { rateAnnual: rateAnnual.toFixed(2), maxAnnual: max.toFixed(2), source: cap.sourceResolution ?? null };
  if (cfg.policy === 'bloquear') {
    throw httpError(422, 'RATE_ABOVE_LEGAL_CAP', `La tasa equivale a ${details.rateAnnual}% EA y el máximo legal vigente es ${details.maxAnnual}% EA`, details);
  }
  if (!acknowledge) {
    throw httpError(422, 'RATE_CAP_ACK_REQUIRED', `La tasa equivale a ${details.rateAnnual}% EA y supera el máximo legal de ${details.maxAnnual}% EA. Confirma para continuar.`, details);
  }
  return { ...base, rateCapCheck: 'excede_confirmado', rateCapAckBy: membershipId, rateCapAckAt: at };
}
