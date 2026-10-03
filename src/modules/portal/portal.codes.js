import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { PortalChallenge } from './portalChallenge.model.js';

export const hashPortalCode = (id, code) => createHmac('sha256', env.DATA_HASH_SECRET).update(`portal:${id}:${code}`).digest('hex');

export const sameCode = (challenge, code) => Boolean(challenge?.codeHash)
  && timingSafeEqual(Buffer.from(challenge.codeHash, 'hex'), Buffer.from(hashPortalCode(challenge._id, code), 'hex'));

/** Crea un código de 6 dígitos para el portal (no lo guarda en claro). */
export function newPortalChallenge({ orgId, borrowerId, channel, minutes, ip }) {
  const challenge = new PortalChallenge({ orgId, borrowerId, channel, ip, expiresAt: new Date(Date.now() + minutes * 60_000) });
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  challenge.codeHash = hashPortalCode(challenge._id, code);
  return { challenge, code };
}
