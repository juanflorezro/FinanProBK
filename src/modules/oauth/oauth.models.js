import mongoose from 'mongoose';
import { ref } from '../../db/types.js';

// Servidor OAuth 2.1 propio para conectar FinanPro a ChatGPT/Claude (MCP). Colecciones de plataforma (sin tenant).

const clientSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  secretHash: String,                       // solo si el cliente es confidencial
  name: String,
  redirectUris: [String],
  kind: { type: String, enum: ['dcr', 'cimd'], default: 'dcr' }, // registro dinámico o documento de metadatos
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
export const OAuthClient = mongoose.model('OAuthClient', clientSchema, 'oauth_clients');

const codeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true },
  clientId: { type: String, required: true },
  clientName: String,
  userId: ref('User', { required: true }),
  orgId: ref('Organization', { required: true }),
  redirectUri: { type: String, required: true },
  codeChallenge: { type: String, required: true },
  scope: String,
  resource: String,
  expiresAt: { type: Date, required: true },
  usedAt: Date,
}, { versionKey: false });
codeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 600 });
export const OAuthCode = mongoose.model('OAuthCode', codeSchema, 'oauth_codes');

// Una conexión aprobada (refresh token). Revocarla desconecta la app.
const grantSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  clientId: { type: String, required: true },
  clientName: String,
  userId: ref('User', { required: true }),
  orgId: ref('Organization', { required: true }),
  scope: String,
  resource: String,
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  lastUsedAt: Date,
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
grantSchema.index({ userId: 1, orgId: 1, revokedAt: 1 });
grantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });
export const OAuthGrant = mongoose.model('OAuthGrant', grantSchema, 'oauth_grants');
