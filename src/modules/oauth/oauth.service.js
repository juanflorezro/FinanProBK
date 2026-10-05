import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { OAuthClient, OAuthCode, OAuthGrant } from './oauth.models.js';

export const SCOPE = 'finanpro';
export const ACCESS_TTL = 3600;              // 1 hora
const REFRESH_DAYS = 60;
const CODE_TTL_MS = 5 * 60_000;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** URL pública del backend (https://finan-pro-api-three.vercel.app) */
export const publicBase = (req) => (env.API_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
export const resourceUrl = (req) => `${publicBase(req)}/api/mcp`;

export class OAuthError extends Error {
  constructor(error, description, status = 400) { super(description); this.error = error; this.status = status; }
}

const isAllowedRedirect = (uri) => {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch { return false; }
};

/** Registro dinámico de clientes (RFC 7591). */
export async function registerClient(meta) {
  const uris = Array.isArray(meta?.redirect_uris) ? meta.redirect_uris : [];
  if (!uris.length || !uris.every(isAllowedRedirect)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris debe tener URLs https');
  const confidential = meta.token_endpoint_auth_method && meta.token_endpoint_auth_method !== 'none';
  const clientId = `fp_${token(18)}`;
  const secret = confidential ? token(32) : null;
  await OAuthClient.create({ clientId, secretHash: secret && sha256(secret), name: String(meta.client_name ?? 'Aplicación').slice(0, 80), redirectUris: uris, kind: 'dcr' });
  return {
    client_id: clientId,
    ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: meta.client_name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: confidential ? (meta.token_endpoint_auth_method === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post') : 'none',
  };
}

/**
 * Busca el cliente. Soporta client_id registrado (DCR) o una URL https con el
 * documento de metadatos del cliente (CIMD), que es lo que ChatGPT usa por defecto.
 */
export async function resolveClient(clientId) {
  if (!clientId) throw new OAuthError('invalid_client', 'Falta client_id');
  if (/^https:\/\//.test(clientId)) {
    const cached = await OAuthClient.findOne({ clientId });
    if (cached && Date.now() - cached.createdAt < 3_600_000) return cached;
    const res = await fetch(clientId, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res?.ok) throw new OAuthError('invalid_client', 'No se pudo leer el documento del cliente');
    const doc = await res.json().catch(() => null);
    if (!doc || doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(isAllowedRedirect)) {
      throw new OAuthError('invalid_client', 'Documento de cliente inválido');
    }
    return OAuthClient.findOneAndUpdate(
      { clientId },
      { $set: { name: String(doc.client_name ?? new URL(clientId).hostname).slice(0, 80), redirectUris: doc.redirect_uris, kind: 'cimd', createdAt: new Date() } },
      { upsert: true, new: true },
    );
  }
  const client = await OAuthClient.findOne({ clientId });
  if (!client) throw new OAuthError('invalid_client', 'Cliente no registrado');
  return client;
}

/** Valida una solicitud de autorización (lo que llega a /oauth/authorize). */
export async function validateAuthorizeRequest(q, expectedResource) {
  const client = await resolveClient(q.client_id);
  if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) throw new OAuthError('invalid_request', 'redirect_uri no autorizada para este cliente');
  // A partir de aquí los errores se devuelven a la redirect_uri
  if (q.response_type !== 'code') throw Object.assign(new OAuthError('unsupported_response_type', 'Solo response_type=code'), { redirect: true });
  if (!q.code_challenge || (q.code_challenge_method ?? 'plain') !== 'S256') {
    throw Object.assign(new OAuthError('invalid_request', 'PKCE con S256 es obligatorio'), { redirect: true });
  }
  if (q.resource && q.resource.replace(/\/$/, '') !== expectedResource) {
    throw Object.assign(new OAuthError('invalid_target', 'resource desconocido'), { redirect: true });
  }
  return client;
}

export async function createCode({ client, userId, orgId, q }) {
  const code = token(32);
  await OAuthCode.create({
    codeHash: sha256(code), clientId: client.clientId, clientName: client.name, userId, orgId,
    redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, scope: SCOPE, resource: q.resource,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

function verifyClientSecret(client, secret) {
  if (!client.secretHash) return true; // cliente público: lo protege PKCE
  if (!secret) return false;
  const a = Buffer.from(client.secretHash, 'hex');
  const b = Buffer.from(sha256(secret), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function signAccess({ userId, orgId, clientId, iss, aud }) {
  return jwt.sign({ sub: String(userId), org: String(orgId), cid: clientId, scope: SCOPE }, env.JWT_ACCESS_SECRET, {
    audience: aud, issuer: iss, expiresIn: ACCESS_TTL,
  });
}

async function issueTokens({ userId, orgId, client, resource, iss, aud }) {
  const refresh = token(40);
  await OAuthGrant.create({
    tokenHash: sha256(refresh), clientId: client.clientId, clientName: client.name, userId, orgId, scope: SCOPE, resource,
    expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000), lastUsedAt: new Date(),
  });
  return { access_token: signAccess({ userId, orgId, clientId: client.clientId, iss, aud }), token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
}

/** /oauth/token: authorization_code (con PKCE) y refresh_token (con rotación). */
export async function exchangeToken(body, clientSecret, { iss, aud }) {
  const client = await resolveClient(body.client_id);
  if (!verifyClientSecret(client, clientSecret)) throw new OAuthError('invalid_client', 'Credenciales del cliente inválidas', 401);

  if (body.grant_type === 'authorization_code') {
    const row = await OAuthCode.findOneAndUpdate(
      { codeHash: sha256(String(body.code ?? '')), usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
    );
    if (!row || row.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Código inválido o vencido');
    if (body.redirect_uri && body.redirect_uri !== row.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri no coincide');
    const verifier = String(body.code_verifier ?? '');
    if (!verifier || createHash('sha256').update(verifier).digest('base64url') !== row.codeChallenge) throw new OAuthError('invalid_grant', 'code_verifier incorrecto');
    return issueTokens({ userId: row.userId, orgId: row.orgId, client, resource: row.resource, iss, aud });
  }

  if (body.grant_type === 'refresh_token') {
    const grant = await OAuthGrant.findOneAndUpdate(
      { tokenHash: sha256(String(body.refresh_token ?? '')), revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { revokedAt: new Date() } }, // rotación: el refresh usado deja de servir
    );
    if (!grant || grant.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Refresh token inválido');
    return issueTokens({ userId: grant.userId, orgId: grant.orgId, client, resource: grant.resource, iss, aud });
  }

  throw new OAuthError('unsupported_grant_type', 'grant_type no soportado');
}

export async function revokeToken(tokenValue) {
  await OAuthGrant.updateOne({ tokenHash: sha256(String(tokenValue ?? '')), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export function verifyMcpAccessToken(t, { iss, aud }) {
  return jwt.verify(t, env.JWT_ACCESS_SECRET, { audience: aud, issuer: iss });
}
