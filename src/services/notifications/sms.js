import { env } from '../../config/env.js';

let client = null;
const configured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

export const smsEnabled = () => configured;

/** Celular colombiano 3001234567 → +573001234567. Si ya trae +, se respeta. */
export function toE164(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (String(phone).trim().startsWith('+')) return `+${digits}`;
  return `${env.SMS_COUNTRY_CODE}${digits}`;
}

/** Envía un SMS con Twilio. Sin credenciales (desarrollo) lo imprime en la consola. */
export async function sendSms(to, body) {
  if (!configured) {
    console.log(`\n[SMS DEV] Para: ${to}\n${body}\n`);
    return { dev: true };
  }
  if (!client) {
    const { default: twilio } = await import('twilio');
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return client.messages.create({ to, from: env.TWILIO_FROM, body });
}
