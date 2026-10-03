import { runSubscriptionCheck } from '../modules/platform/subscription.service.js';

// Correr una vez al día: vencidas → gracia (5 días) → organización en solo lectura.
// agenda.define('subscription-check', () => checkSubscriptions());
export async function checkSubscriptions() {
  return runSubscriptionCheck(new Date());
}
