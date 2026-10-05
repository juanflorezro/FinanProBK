import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().startsWith('mongodb'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  DATA_HASH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  GOOGLE_CLIENT_ID: z.string().min(1),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Préstamos <no-reply@localhost>'),
  MONGO_AUTO_INDEX: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CRON_SECRET: z.string().optional(),
  API_PUBLIC_URL: z.string().url().optional(), // URL pública del backend (para OAuth/MCP); si no, se toma del Host
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const detail = parsed.error.flatten().fieldErrors;
  console.error('Variables de entorno inválidas o faltantes:', detail);
  // En Vercel no se puede cortar el proceso: se lanza el error para que salga en los logs
  if (process.env.VERCEL) throw new Error(`Faltan o son inválidas: ${Object.keys(detail).join(', ')}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isServerless = Boolean(process.env.VERCEL);
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
