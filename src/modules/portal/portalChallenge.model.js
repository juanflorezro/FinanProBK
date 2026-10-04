import mongoose from 'mongoose';
import { ref, enumOf } from '../../db/types.js';

// Código de acceso al portal del deudor. Se borra solo 1 hora después de vencer.
const schema = new mongoose.Schema({
  orgId: ref('Organization'),              // vacío en el portal global (se entra por correo)
  email: { type: String, lowercase: true, trim: true },
  borrowerId: ref('Borrower'),             // null si el documento no existe (respuesta igual, sin revelar nada)
  codeHash: String,
  channel: enumOf(['email', 'manual', 'none'], { default: 'none' }),
  attempts: { type: Number, default: 0 },
  ip: String,
  expiresAt: { type: Date, required: true },
  verifiedAt: Date,
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
schema.index({ borrowerId: 1, createdAt: -1 });
schema.index({ email: 1, createdAt: -1 });

export const PortalChallenge = mongoose.model('PortalChallenge', schema, 'portal_challenges');
