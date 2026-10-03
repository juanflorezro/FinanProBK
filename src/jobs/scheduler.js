import { Agenda } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import { env } from '../config/env.js';
import { runDailyAccrual } from './dailyAccrual.js';
import { checkSubscriptions } from './subscriptionCheck.js';

let agenda = null;

/**
 * Tareas programadas guardadas en Mongo (colección "jobs").
 * Con varias instancias del servidor, agenda bloquea cada tarea para que corra una sola vez.
 */
export async function startScheduler() {
  if (process.env.DISABLE_JOBS === 'true') return null;

  agenda = new Agenda({
    backend: new MongoBackend({ address: env.MONGODB_URI, collection: 'jobs' }),
    processEvery: '1 minute',
  });

  agenda.define('daily-accrual', async () => {
    const r = await runDailyAccrual(new Date());
    console.log(`[jobs] mora diaria: ${r.loans} préstamos en ${r.orgs} organizaciones, ${r.errors.length} errores`);
  });
  agenda.define('subscription-check', async () => {
    const r = await checkSubscriptions();
    console.log(`[jobs] suscripciones: ${r.enGracia} a gracia, ${r.vencidas} vencidas`);
  });

  await agenda.start();
  await agenda.every('0 5 * * *', 'daily-accrual', {}, { timezone: 'America/Bogota' });
  await agenda.every('15 5 * * *', 'subscription-check', {}, { timezone: 'America/Bogota' });
  console.log('Tareas programadas activas (5:00 a. m. hora Colombia)');
  return agenda;
}

export async function stopScheduler() {
  if (agenda) await agenda.stop();
}
