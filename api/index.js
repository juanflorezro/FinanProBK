// Punto de entrada para Vercel: una función serverless que atiende toda la API.
import { createApp } from '../src/app.js';
import { connectDB } from '../src/db/connect.js';

const app = createApp();

export default async function handler(req, res) {
  try {
    await connectDB();
  } catch (err) {
    console.error('No se pudo conectar a MongoDB:', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'DB_UNAVAILABLE', message: 'No se pudo conectar a la base de datos. Revisa MONGODB_URI y el acceso de red en Atlas (0.0.0.0/0).' }));
  }
  return app(req, res);
}
