import mongoose from 'mongoose';
import { env, isProd } from '../config/env.js';

mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true); // bloquea inyección tipo { $gt: '' } en filtros

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
