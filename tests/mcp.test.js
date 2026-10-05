import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

// Flujo completo OAuth 2.1 + MCP con la base de datos simulada en memoria.
const seen = { payment: null };
let app;
const db = { clients: [], codes: [], grants: [] };
const userId = new mongoose.Types.ObjectId();
const orgId = new mongoose.Types.ObjectId();
const user = { _id: userId, name: 'Laura Pérez', email: 'laura@caribe.co', status: 'activo' };
const match = (row, f) => Object.entries(f).every(([k, v]) => {
  if (v && typeof v === 'object' && '$gt' in v) return row[k] > v.$gt;
  if (v === null) return row[k] == null;
  return String(row[k]) === String(v);
});

beforeAll(async () => {
  Object.assign(process.env, {
    MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32),
    DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 'g', APP_URL: 'https://app.example.com',
  });
  const { OAuthClient, OAuthCode, OAuthGrant } = await import('../src/modules/oauth/oauth.models.js');
  const { User } = await import('../src/modules/auth/user.model.js');
  const { Membership } = await import('../src/modules/users/membership.model.js');
  const { Organization } = await import('../src/modules/organizations/organization.model.js');
  const { AuditLog } = await import('../src/modules/audit/auditLog.model.js');

  vi.spyOn(OAuthClient, 'create').mockImplementation(async (d) => { db.clients.push({ ...d, createdAt: new Date() }); return d; });
  vi.spyOn(OAuthClient, 'findOne').mockImplementation(async (f) => db.clients.find((c) => match(c, f)) ?? null);
  vi.spyOn(OAuthCode, 'create').mockImplementation(async (d) => { db.codes.push({ ...d, usedAt: null }); return d; });
  vi.spyOn(OAuthCode, 'findOneAndUpdate').mockImplementation(async (f, u) => {
    const row = db.codes.find((c) => c.codeHash === f.codeHash && c.usedAt == null && c.expiresAt > new Date());
    if (row) Object.assign(row, u.$set);
    return row ?? null;
  });
  vi.spyOn(OAuthGrant, 'create').mockImplementation(async (d) => { db.grants.push({ ...d, revokedAt: null }); return d; });
  vi.spyOn(OAuthGrant, 'findOneAndUpdate').mockImplementation(async (f, u) => {
    const row = db.grants.find((g) => g.tokenHash === f.tokenHash && g.revokedAt == null);
    if (row) { const before = { ...row }; Object.assign(row, u.$set); return before; }
    return null;
  });
  vi.spyOn(User, 'findById').mockImplementation(async (id) => (String(id) === String(userId) ? user : null));
  vi.spyOn(Membership, 'findOne').mockImplementation(async (f) => (String(f.userId) === String(userId) && String(f.orgId) === String(orgId) ? { role: 'owner', orgId } : null));
  vi.spyOn(Organization, 'findById').mockImplementation(() => ({ select: async () => ({ _id: orgId, name: 'Créditos del Caribe', currency: 'COP', status: 'activa' }) }));
  vi.spyOn(AuditLog, 'create').mockResolvedValue({});

  const { oauthPublic, oauthApp } = await import('../src/modules/oauth/oauth.routes.js');
  const { default: mcp } = await import('../src/modules/mcp/mcp.routes.js');
  const { errorHandler } = await import('../src/middlewares/errorHandler.js');
  const { authenticate } = await import('../src/middlewares/authenticate.js');

  const helmet = (await import('helmet')).default;
  const compression = (await import('compression')).default;
  const { sanitize } = await import('../src/middlewares/sanitize.js');
  const { validate } = await import('../src/middlewares/validate.js');
  const { z } = await import('zod');
  app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(compression());
  app.use(express.json());
  app.use(sanitize);
  app.use(oauthPublic);
  app.use('/api/oauth', oauthApp);
  app.use('/api/mcp', mcp);
  // API REST simulada: las herramientas MCP la llaman EN MEMORIA con la sesión del usuario
  app.get('/api/dashboard', authenticate, (req, res) => res.json({
    portfolio: { activeLoans: 3, balancePrincipal: 112000000, interestDue: 0, lateInterestDue: 120000, overdueLoans: 1, overdueBalance: 50000000, activeBorrowers: 2, pendingDisbursement: 0 },
    month: { collected: 9800000, collectedPrincipal: 7000000, collectedInterest: 2800000, payments: 4, disbursed: 0, disbursedLoans: 0 },
    aging: {}, overdue: [], upcoming: [], recentPayments: [], orgHeader: req.get('x-org-id'),
  }));
  app.post('/api/borrowers', authenticate, validate({ body: z.object({ docNumber: z.string().min(4) }).passthrough() }), (req, res) => (req.body.docNumber === '11111111'
    ? res.status(409).json({ error: 'DUPLICATE', message: 'Ya existe un registro con esos datos' })
    : res.status(201).json({ _id: 'b1', code: 'C0007', ...req.body })));
  app.get('/api/loans', authenticate, (req, res) => res.json({ total: 1, page: 1, items: [{ _id: '66f0000000000000000000aa', loanNumber: 'P000021', borrowerId: { firstName: 'Juan', lastName: 'Pérez' }, principal: 100000000, balancePrincipal: 62000000, status: 'al_dia', q: req.query.q }] }));
  app.get('/api/loans/:id', authenticate, (req, res) => res.json({ loan: { _id: req.params.id, loanNumber: 'P000021', borrowerId: { firstName: 'Juan', lastName: 'Pérez' }, balancePrincipal: 61000000, balanceInterest: 0, balanceLateInterest: 0, status: 'al_dia', daysPastDue: 0 }, installments: [], payments: [] }));
  app.get('/api/cash-accounts', authenticate, (_req, res) => res.json([{ _id: 'c1', name: 'Principal', type: 'efectivo', isActive: true }]));
  app.post('/api/payments', authenticate, (req, res) => {
    seen.payment = { body: req.body, idem: req.get('idempotency-key') };
    res.status(201).json({ _id: 'p1', receiptNumber: '000413', amount: req.body.amount, method: req.body.method, status: 'aplicado' });
  });
  app.post('/api/members/invitations', authenticate, (_req, res) => res.status(403).json({ error: 'FORBIDDEN', message: 'Tu rol no permite: member.create' }));
  app.use(errorHandler);
});

const b64 = (b) => b.toString('base64url');
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
const rpc = (token, id, method, params) => request(app).post('/api/mcp').set(H).set('authorization', `Bearer ${token}`).set('host', 'api.example.com').set('x-forwarded-proto', 'https').send({ jsonrpc: '2.0', id, method, params });

describe('OAuth + MCP para ChatGPT', () => {
  let tokens;
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());

  it('sin token responde 401 y dice dónde está la metadata OAuth', async () => {
    const r = await request(app).post('/api/mcp').set(H).set('host', 'api.example.com').set('x-forwarded-proto', 'https').send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api/mcp"');
    const g = await request(app).get('/api/mcp').set('host', 'api.example.com').set('x-forwarded-proto', 'https');
    expect(g.status).toBe(401); // el sondeo GET también descubre OAuth
    expect(g.headers['www-authenticate']).toContain('resource_metadata=');
    const meta = await request(app).get('/.well-known/oauth-protected-resource/api/mcp').set('host', 'api.example.com').set('x-forwarded-proto', 'https');
    expect(meta.body.resource).toBe('https://api.example.com/api/mcp');
    const as = await request(app).get('/.well-known/oauth-authorization-server').set('host', 'api.example.com').set('x-forwarded-proto', 'https');
    expect(as.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.body.registration_endpoint).toBe('https://api.example.com/oauth/register');
  });

  it('registro, autorización con PKCE, token y llamadas MCP', async () => {
    const reg = await request(app).post('/oauth/register').send({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector/oauth/abc'], token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id;

    const params = { response_type: 'code', client_id: clientId, redirect_uri: 'https://chatgpt.com/connector/oauth/abc', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: 'https://api.example.com/api/mcp' };
    const auth = await request(app).get('/oauth/authorize').query(params).set('host', 'api.example.com').set('x-forwarded-proto', 'https');
    expect(auth.status).toBe(302);
    expect(auth.headers.location).toMatch(/^https:\/\/app\.example\.com\/oauth\/autorizar\?/);

    const { signAccessToken } = await import('../src/modules/auth/tokens.js');
    const appToken = signAccessToken(user);
    const approve = await request(app).post('/api/oauth/approve').set('authorization', `Bearer ${appToken}`).set('host', 'api.example.com').set('x-forwarded-proto', 'https')
      .send({ ...params, decision: 'allow', orgId: String(orgId) });
    expect(approve.status).toBe(200);
    const back = new URL(approve.body.redirect);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code');

    const bad = await request(app).post('/oauth/token').type('form').set('host', 'api.example.com').set('x-forwarded-proto', 'https')
      .send({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: params.redirect_uri, code_verifier: 'otro-verificador-que-no-coincide-xxxxxxxxxxx' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');
    // un código ya intentado queda gastado; se pide otro
    const approve2 = await request(app).post('/api/oauth/approve').set('authorization', `Bearer ${appToken}`).set('host', 'api.example.com').set('x-forwarded-proto', 'https').send({ ...params, decision: 'allow', orgId: String(orgId) });
    const code2 = new URL(approve2.body.redirect).searchParams.get('code');

    const tok = await request(app).post('/oauth/token').type('form').set('host', 'api.example.com').set('x-forwarded-proto', 'https')
      .send({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: params.redirect_uri, code_verifier: verifier });
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe('Bearer');
    tokens = { ...tok.body, clientId };

    const init = await rpc(tokens.access_token, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chatgpt', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('finanpro');

    const list = await rpc(tokens.access_token, 2, 'tools/list', {});
    const names = list.body.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['quien_soy', 'resumen_cartera', 'buscar_prestamos', 'registrar_deudor', 'crear_prestamo', 'registrar_pago', 'reversar_pago', 'invitar_miembro', 'escribir_a_soporte']));
    expect(names.length).toBeGreaterThanOrEqual(25);

    const resumen = await rpc(tokens.access_token, 3, 'tools/call', { name: 'resumen_cartera', arguments: {} });
    expect(resumen.body.result.structuredContent.cartera.capital_por_cobrar).toBe(1120000);

    const nuevo = await rpc(tokens.access_token, 4, 'tools/call', { name: 'registrar_deudor', arguments: { tipo_documento: 'CC', numero_documento: '1002442323', nombres: 'Juan', apellidos: 'Pérez', celular: '300 123 4567' } });
    expect(nuevo.body.result.structuredContent.codigo).toBe('C0007');

    const pago = await rpc(tokens.access_token, 6, 'tools/call', { name: 'registrar_pago', arguments: { prestamo: 'P000021', valor: 150000.5, medio: 'nequi' } });
    expect(pago.body.result.structuredContent.recibo).toBe('000413');
    expect(pago.body.result.structuredContent).toMatchObject({ prestamo: 'P000021', deudor: 'Juan Pérez', caja: 'Principal' });
    expect(pago.body.result.structuredContent.prestamo_despues.saldo_capital).toBe(610000);
    expect(seen.payment.body).toMatchObject({ loanId: '66f0000000000000000000aa', amount: 15000050, method: 'nequi', cashAccountId: 'c1' });
    expect(seen.payment.idem).toMatch(/^[0-9a-f-]{36}$/);

    const sinPermiso = await rpc(tokens.access_token, 7, 'tools/call', { name: 'invitar_miembro', arguments: { correo: 'x@y.co', rol: 'cobrador' } });
    expect(sinPermiso.body.result.isError).toBe(true);
    expect(sinPermiso.body.result.content[0].text).toContain('Tu rol no permite');

    const dup = await rpc(tokens.access_token, 5, 'tools/call', { name: 'registrar_deudor', arguments: { tipo_documento: 'CC', numero_documento: '11111111', nombres: 'A', apellidos: 'B', celular: '3001234567' } });
    expect(dup.body.result.isError).toBe(true);
    expect(dup.body.result.content[0].text).toContain('Ya existe un registro');
  });

  it('el refresh token rota y el viejo deja de servir', async () => {
    const send = (rt) => request(app).post('/oauth/token').type('form').set('host', 'api.example.com').set('x-forwarded-proto', 'https')
      .send({ grant_type: 'refresh_token', refresh_token: rt, client_id: tokens.clientId });
    const r1 = await send(tokens.refresh_token);
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    const r2 = await send(tokens.refresh_token);
    expect(r2.status).toBe(400);
  });

  it('un token de la app normal no sirve para el MCP', async () => {
    const { signAccessToken } = await import('../src/modules/auth/tokens.js');
    const r = await rpc(signAccessToken(user), 9, 'tools/list', {});
    expect(r.status).toBe(401);
  });
});
