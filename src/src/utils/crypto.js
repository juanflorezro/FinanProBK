import { createHash, createHmac, randomBytes } from 'node:crypto';
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
