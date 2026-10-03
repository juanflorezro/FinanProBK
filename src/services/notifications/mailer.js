import nodemailer from 'nodemailer';
import { env, isProd } from '../../config/env.js';

const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  })
  : null;

if (!transporter && isProd) console.warn('SMTP no configurado: los correos no se enviarán');

/** Sin SMTP (desarrollo) el correo se imprime en la consola, así puedes ver el código. */
export async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`\n[CORREO DEV] Para: ${to}\nAsunto: ${subject}\n${text}\n`);
    return { dev: true };
  }
  return transporter.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
}
