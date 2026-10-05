import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { publicBase, resourceUrl, verifyMcpAccessToken } from '../oauth/oauth.service.js';
import { hasPermission } from '../../config/permissions.js';
import { runWithContext } from '../../db/context.js';
import { User } from '../auth/user.model.js';
import { Membership } from '../users/membership.model.js';
import { Organization } from '../organizations/organization.model.js';
import { AuditLog } from '../audit/auditLog.model.js';
import { registerTools } from './mcp.tools.js';

/**
 * Servidor MCP de FinanPro (Streamable HTTP, sin estado) protegido con OAuth.
 * ChatGPT/Claude se conectan a https://<backend>/api/mcp
 */
const router = Router();

function unauthorized(req, res, description) {
  res.set('WWW-Authenticate', `Bearer resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource/api/mcp", error="invalid_token", error_description="${description}"`);
  res.status(401).json({ error: 'invalid_token', error_description: description });
}

async function mcpAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return unauthorized(req, res, 'Falta el token');
  let claims;
  try {
    claims = verifyMcpAccessToken(header.slice(7), { iss: publicBase(req), aud: resourceUrl(req) });
  } catch {
    return unauthorized(req, res, 'Token inválido o vencido');
  }
  const [user, membership, org] = await Promise.all([
    User.findById(claims.sub),
    Membership.findOne({ userId: claims.sub, orgId: claims.org, status: 'activa' }),
    Organization.findById(claims.org).select('name currency status'),
  ]);
  if (!user || user.status !== 'activo' || !membership || !org) return unauthorized(req, res, 'Ya no tienes acceso a esta empresa');
  req.mcp = { user, membership, org, clientId: claims.cid };
  next();
}

const DUP = 'Ya existe un registro con esos datos (por ejemplo, el mismo documento).';

/**
 * Ejecuta una acción como el usuario conectado: valida el permiso del rol, que la empresa
 * pueda escribir, corre dentro del contexto de la empresa y deja rastro en la bitácora.
 */
function runnerFor(req) {
  const { user, membership, org, clientId } = req.mcp;
  return async (permission, fn, { write = false, action } = {}) => {
    if (!hasPermission(membership.role, permission)) throw new Error(`Tu rol (${membership.role}) no permite esta acción (${permission}).`);
    if (write && org.status !== 'activa') throw new Error('La empresa está en solo lectura o suspendida: no se pueden crear ni modificar datos.');
    try {
      const out = await runWithContext({ orgId: org._id, userId: user._id, membershipId: membership._id, requestId: req.id }, () => fn(org));
      if (write) AuditLog.create({ orgId: org._id, actorType: 'user', actorId: user._id, action: action ?? 'mcp.write', entity: 'MCP', after: { clientId }, ip: req.ip, requestId: req.id }).catch(() => {});
      return out;
    } catch (err) {
      if (err?.code === 11000) throw new Error(DUP);
      if (err?.issues) throw new Error(err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      throw err;
    }
  };
}

router.post('/', mcpAuth, async (req, res) => {
  const { user, membership, org } = req.mcp;
  const server = new McpServer(
    { name: 'finanpro', title: 'FinanPro', version: '1.0.0' },
    { instructions: `FinanPro es la plataforma de préstamos de ${org.name}. Montos en pesos (${org.currency}). Antes de crear o modificar datos, confirma con el usuario.` },
  );
  const ctx = { userName: user.name ?? user.email, userEmail: user.email, orgName: org.name, role: membership.role, currency: org.currency };
  registerTools(server, { ctx, run: runnerFor(req) });
  // Los errores de una herramienta vuelven al chat como mensaje, no como caída del servidor
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Modo sin estado: no hay stream GET ni sesiones que cerrar
router.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }));
router.delete('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' }));

export default router;
