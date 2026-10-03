import { env } from './config/env.js';
import { connectDB, disconnectDB } from './db/connect.js';
import { createApp } from './app.js';

await connectDB();
const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`API escuchando en http://localhost:${env.PORT}/api (${env.NODE_ENV})`);
});

// Las tareas programadas no deben tumbar la API si fallan al iniciar
let scheduler = null;
import('./jobs/scheduler.js')
  .then(async (m) => { scheduler = m; await m.startScheduler(); })
  .catch((err) => console.error('Tareas programadas desactivadas:', err.message));

async function shutdown(signal) {
  console.log(`${signal} recibido, cerrando...`);
  server.close(async () => {
    await scheduler?.stopScheduler().catch(() => {});
    await disconnectDB();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
