import mongoose from 'mongoose';
import { env, isServerless } from '../config/env.js';

mongoose.set('strictQuery', true);
// sanitizeFilter queda apagado: también bloquearía los filtros que arma el propio servidor
// ($gt, $in, $ne...). La inyección se frena antes: middlewares/sanitize.js quita las claves
// con $ del body y zod valida query y params como texto, nunca como objeto.
mongoose.set('sanitizeFilter', false);

let connecting = null;
let listeners = false;

/** Conecta una sola vez y reutiliza la conexión (necesario en Vercel, donde la función se reutiliza). */
export async function connectDB() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!listeners) {
    listeners = true;
    mongoose.connection.on('connected', () => console.log('MongoDB conectado'));
    mongoose.connection.on('error', (err) => console.error('MongoDB error', err.message));
    mongoose.connection.on('disconnected', () => console.warn('MongoDB desconectado'));
  }
  connecting ??= mongoose.connect(env.MONGODB_URI, {
    autoIndex: env.MONGO_AUTO_INDEX, // crea los índices al arrancar (idempotente)
    maxPoolSize: isServerless ? 5 : 20,
    serverSelectionTimeoutMS: 10000,
  }).catch((err) => { connecting = null; throw err; });
  await connecting;
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
