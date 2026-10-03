import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { httpError } from '../../utils/errors.js';
import { sendMail } from '../../services/notifications/mailer.js';
import { verificationCodeEmail } from '../../services/notifications/templates.js';
import { Verification } from './verification.model.js';

const CODE_MINUTES = 15;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

const hashCode = (email, purpose, code) =>
  createHmac('sha256', env.DATA_HASH_SECRET).update(`${purpose}:${email}:${code}`).digest('hex');

/** Genera y envía un código de 6 dígitos. Respeta 60 s entre envíos. */
export async function sendCode(email, purpose) {
  const existing = await Verification.findOne({ email, purpose });
  if (existing?.lastSentAt && Date.now() - existing.lastSentAt < RESEND_SECONDS * 1000) {
    const wait = Math.ceil((RESEND_SECONDS * 1000 - (Date.now() - existing.lastSentAt)) / 1000);
    throw httpError(429, 'CODE_COOLDOWN', `Espera ${wait} segundos para pedir otro código`, { retryAfter: wait });
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await Verification.findOneAndUpdate(
    { email, purpose },
    {
      $set: {
        codeHash: hashCode(email, purpose, code),
        attempts: 0,
        expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
        lastSentAt: new Date(),
        consumedAt: null,
      },
    },
    { upsert: true },
  );
  await sendMail({ to: email, ...verificationCodeEmail({ code, purpose, minutes: CODE_MINUTES }) });
  return { expiresInMinutes: CODE_MINUTES, resendInSeconds: RESEND_SECONDS };
}

/** Valida el código y lo consume. Máximo 5 intentos por código. */
export async function consumeCode(email, purpose, code) {
  const doc = await Verification.findOne({ email, purpose, consumedAt: null });
  if (!doc || doc.expiresAt < new Date()) throw httpError(400, 'CODE_EXPIRED', 'El código venció, pide uno nuevo');
  if (doc.attempts >= MAX_ATTEMPTS) throw httpError(429, 'CODE_TOO_MANY_ATTEMPTS', 'Demasiados intentos, pide un código nuevo');

  const expected = Buffer.from(doc.codeHash, 'hex');
  const given = Buffer.from(hashCode(email, purpose, String(code).trim()), 'hex');
  if (!timingSafeEqual(expected, given)) {
    doc.attempts += 1;
    await doc.save();
    const left = MAX_ATTEMPTS - doc.attempts;
    throw httpError(400, 'CODE_INVALID', left > 0 ? `Código incorrecto, te quedan ${left} intentos` : 'Código incorrecto, pide uno nuevo');
  }
  doc.consumedAt = new Date();
  await doc.save();
}
