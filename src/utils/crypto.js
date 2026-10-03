import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 48) => randomBytes(bytes).toString('base64url');

/** Hash para buscar por documento sin exponerlo (portal del deudor). */
export const documentHash = (orgId, docType, docNumber) =>
  createHmac('sha256', env.DATA_HASH_SECRET)
    .update(`${orgId}:${docType}:${String(docNumber).replace(/\D/g, '')}`)
    .digest('hex');

export const slugify = (text) =>
  String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);

// Cifrado simétrico para secretos guardados en BD (ej. TOTP). Formato: iv.tag.datos (base64url)
const encKey = () => createHash('sha256').update(`${env.DATA_HASH_SECRET}:enc`).digest();

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, data] = String(payload).split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export const hmac = (value) => createHmac('sha256', env.DATA_HASH_SECRET).update(String(value)).digest('hex');

export const maskEmail = (email) => {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
};
