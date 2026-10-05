import { Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { httpError } from '../../utils/errors.js';
import { objectId } from '../../utils/schemas.js';
import { Membership } from '../users/membership.model.js';
import { Organization } from '../organizations/organization.model.js';
import { OAuthGrant } from './oauth.models.js';
import {
  SCOPE, OAuthError, publicBase, resourceUrl, registerClient, validateAuthorizeRequest, createCode,
  exchangeToken, revokeToken, resolveClient,
} from './oauth.service.js';

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const oauthJson = (res, err) => res.status(err.status ?? 400).set('Cache-Control', 'no-store').json({ error: err.error ?? 'server_error', error_description: err.message });

// ---------------------------------------------------------------- Rutas públicas en la raíz (/.well-known y /oauth)
export const oauthPublic = Router();

const protectedResource = (req, res) => res.json({
  resource: resourceUrl(req),
  authorization_servers: [publicBase(req)],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'FinanPro',
});
oauthPublic.get('/.well-known/oauth-protected-resource', protectedResource);
oauthPublic.get('/.well-known/oauth-protected-resource/api/mcp', protectedResource);

const asMetadata = (req, res) => {
  const base = publicBase(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    service_documentation: `${env.APP_URL}/configuracion`,
  });
};
oauthPublic.get('/.well-known/oauth-authorization-server', asMetadata);
oauthPublic.get('/.well-known/oauth-authorization-server/api/mcp', asMetadata);
oauthPublic.get('/.well-known/openid-configuration', asMetadata);

oauthPublic.post('/oauth/register', limiter, async (req, res) => {
  try { res.status(201).set('Cache-Control', 'no-store').json(await registerClient(req.body)); } catch (err) { oauthJson(res, err); }
});

/** Paso 1: valida y manda al usuario a la pantalla de autorización de la app. */
oauthPublic.get('/oauth/authorize', limiter, async (req, res) => {
  const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
  try {
    const client = await validateAuthorizeRequest(q, resourceUrl(req));
    const params = new URLSearchParams({ ...q, client_name: client.name ?? 'Aplicación' });
    res.redirect(302, `${env.APP_URL}/oauth/autorizar?${params}`);
  } catch (err) {
    if (err.redirect && q.redirect_uri) {
      const u = new URL(q.redirect_uri);
      u.searchParams.set('error', err.error);
      u.searchParams.set('error_description', err.message);
      if (q.state) u.searchParams.set('state', q.state);
      return res.redirect(302, u.toString());
    }
    res.status(400).type('text').send(`No se pudo autorizar: ${err.message}`);
  }
});

oauthPublic.post('/oauth/token', limiter, express.urlencoded({ extended: false }), async (req, res) => {
  let body = { ...req.body };
  let secret = body.client_secret;
  const basic = req.get('authorization');
  if (basic?.startsWith('Basic ')) {
    const [id, sec] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
    body = { ...body, client_id: body.client_id ?? decodeURIComponent(id) };
    secret = decodeURIComponent(sec ?? '');
  }
  try {
    res.set('Cache-Control', 'no-store').json(await exchangeToken(body, secret, { iss: publicBase(req), aud: resourceUrl(req) }));
  } catch (err) { oauthJson(res, err instanceof OAuthError ? err : new OAuthError('server_error', 'Error interno', 500)); }
});

oauthPublic.post('/oauth/revoke', limiter, express.urlencoded({ extended: false }), async (req, res) => {
  await revokeToken(req.body?.token);
  res.status(200).end();
});

// ---------------------------------------------------------------- Rutas de la app (usuario con sesión)
export const oauthApp = Router();

/** El usuario aprueba (o rechaza) desde la pantalla /oauth/autorizar. Devuelve a dónde redirigir. */
oauthApp.post('/approve', authenticate, validate({
  body: z.object({
    decision: z.enum(['allow', 'deny']),
    orgId: objectId.optional(),
    client_id: z.string().min(1),
    redirect_uri: z.string().url(),
    response_type: z.string(),
    code_challenge: z.string().min(20),
    code_challenge_method: z.string(),
    state: z.string().optional(),
    scope: z.string().optional(),
    resource: z.string().optional(),
  }),
}), async (req, res) => {
  const q = req.valid.body;
  const base = publicBase(req);
  let client;
  try { client = await validateAuthorizeRequest(q, resourceUrl(req)); } catch (err) { throw httpError(400, 'OAUTH_INVALID', err.message); }
  const back = new URL(q.redirect_uri);
  if (q.state) back.searchParams.set('state', q.state);
  back.searchParams.set('iss', base);

  if (q.decision === 'deny') {
    back.searchParams.set('error', 'access_denied');
    return res.json({ redirect: back.toString() });
  }
  if (!q.orgId) throw httpError(400, 'ORG_REQUIRED', 'Elige la empresa');
  const membership = await Membership.findOne({ orgId: q.orgId, userId: req.user._id, status: 'activa' });
  if (!membership) throw httpError(403, 'NOT_A_MEMBER', 'No perteneces a esa empresa');
  const code = await createCode({ client, userId: req.user._id, orgId: q.orgId, q });
  back.searchParams.set('code', code);
  res.json({ redirect: back.toString() });
});

/** Datos para la pantalla de autorización (nombre real del cliente). */
oauthApp.get('/client', authenticate, async (req, res) => {
  try {
    const c = await resolveClient(String(req.query.client_id ?? ''));
    res.json({ name: c.name, host: (() => { try { return new URL(c.redirectUris[0]).hostname; } catch { return null; } })() });
  } catch (err) { throw httpError(400, 'OAUTH_INVALID', err.message); }
});

/** Apps conectadas del usuario en una empresa, y revocarlas. */
oauthApp.get('/connections', authenticate, async (req, res) => {
  const grants = await OAuthGrant.find({ userId: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastUsedAt: -1 }).lean();
  const orgs = await Organization.find({ _id: { $in: grants.map((g) => g.orgId) } }).select('name').lean();
  const names = new Map(orgs.map((o) => [String(o._id), o.name]));
  // Una fila por app + empresa (cada refresh rota, se agrupa por cliente)
  const seen = new Map();
  for (const g of grants) {
    const k = `${g.clientId}:${g.orgId}`;
    if (!seen.has(k)) seen.set(k, { clientId: g.clientId, clientName: g.clientName, orgId: g.orgId, orgName: names.get(String(g.orgId)), lastUsedAt: g.lastUsedAt, createdAt: g.createdAt });
  }
  res.json([...seen.values()]);
});

oauthApp.post('/connections/revoke', authenticate, validate({ body: z.object({ clientId: z.string(), orgId: objectId }) }), async (req, res) => {
  const r = await OAuthGrant.updateMany({ userId: req.user._id, clientId: req.valid.body.clientId, orgId: req.valid.body.orgId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  res.json({ revoked: r.modifiedCount });
});
