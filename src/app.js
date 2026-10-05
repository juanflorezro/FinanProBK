import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { corsOrigins, isProd, isServerless } from './config/env.js';
import { sanitize } from './middlewares/sanitize.js';
import { notFound, errorHandler } from './middlewares/errorHandler.js';
import api from './routes.js';
import { oauthPublic } from './modules/oauth/oauth.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // detrás de Render/Railway/Nginx para leer la IP real
  app.disable('x-powered-by');
  app.set('etag', false); // sin ETag: el navegador no recibe 304 vacíos
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.use(pinoHttp({
    genReqId: (req) => req.headers['x-request-id'] ?? randomUUID(),
    transport: isProd || isServerless ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    autoLogging: { ignore: (req) => req.url === '/api/health' },
  }));
  app.use(helmet());
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'Idempotency-Key', 'X-Request-Id'],
  }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(sanitize);

  app.use(oauthPublic);   // /.well-known/* y /oauth/* (OAuth para el MCP)
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
