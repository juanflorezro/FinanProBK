import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { enumOf } from '../../db/types.js';

export const ADMIN_ROLES = ['superadmin', 'finanzas', 'soporte'];

// Administradores de la plataforma (tú y tu equipo). Separados de los usuarios de las empresas.
const platformAdminSchema = createSchema({
  email: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  role: enumOf(ADMIN_ROLES, { default: 'soporte' }),
  status: enumOf(['activo', 'bloqueado'], { default: 'activo' }),
  passwordHash: { type: String, required: true, select: false },
  totpSecret: { type: String, required: true, select: false }, // 2FA obligatorio, cifrado
  lastTotpStep: { type: Number, select: false },
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: Date,
  lastLoginAt: Date,
}, { tenant: false });

platformAdminSchema.index({ email: 1 }, { unique: true });

platformAdminSchema.methods.toPublic = function () {
  return { id: this._id, email: this.email, name: this.name, role: this.role, lastLoginAt: this.lastLoginAt };
};

export const PlatformAdmin = mongoose.model('PlatformAdmin', platformAdminSchema, 'platform_admins');
