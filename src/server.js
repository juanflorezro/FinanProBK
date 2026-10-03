import { env } from './config/env.js';
import { connectDB, disconnectDB } from './db/connect.js';
import { createApp } from './app.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

await connectDB();
const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`API escuchando en http://localhost:${env.PORT}/api (${env.NODE_ENV})`);
});

startScheduler().catch((err) => console.error('No se pudieron iniciar las tareas programadas', err));

async function shutdown(signal) {
  console.log(`${signal} recibido, cerrando...`);
  server.close(async () => {
    await stopScheduler().catch(() => {});
    await disconnectDB();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
