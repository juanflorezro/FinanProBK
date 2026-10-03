import mongoose from 'mongoose';
import { env, isProd } from '../config/env.js';

mongoose.set('strictQuery', true);
// sanitizeFilter queda apagado: también bloquearía los filtros que arma el propio servidor
// ($gt, $in, $ne...). La inyección se frena antes: middlewares/sanitize.js quita las claves
// con $ del body y zod valida query y params como texto, nunca como objeto.
mongoose.set('sanitizeFilter', false);

export async function connectDB() {
  mongoose.connection.on('connected', () => console.log('MongoDB conectado'));
  mongoose.connection.on('error', (err) => console.error('MongoDB error', err));
  mongoose.connection.on('disconnected', () => console.warn('MongoDB desconectado'));

  await mongoose.connect(env.MONGODB_URI, {
    autoIndex: !isProd, // en producción los índices se crean con un script
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 10000,
  });
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
