import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

const userSchema = createSchema({
  email: { type: String, required: true, lowercase: true, trim: true },
  emailVerified: { type: Boolean, default: false },
  trustedDevicesRevokedAt: Date, // invalida los dispositivos de confianza (cambio de contraseña, "cerrar todas")
  name: { type: String, trim: true },
  avatarUrl: String,
  phone: String,
  status: enumOf(['activo', 'bloqueado'], { default: 'activo' }),
  defaultOrgId: ref('Organization'),
  lastLoginAt: Date,
  mfa: {
    totpEnabled: { type: Boolean, default: false },
    totpEnabledAt: Date,
    totpSecret: { type: String, select: false },        // cifrado
    totpPendingSecret: { type: String, select: false }, // mientras confirma la configuración
    lastTotpStep: { type: Number, select: false },      // evita reusar el mismo código
    backupCodes: { type: [String], select: false },     // hash de los códigos de respaldo
  },
}, { tenant: false });

userSchema.index({ email: 1 }, { unique: true });

userSchema.methods.toPublic = function () {
  return { id: this._id, email: this.email, name: this.name, avatarUrl: this.avatarUrl, emailVerified: this.emailVerified, defaultOrgId: this.defaultOrgId, mfaEnabled: Boolean(this.mfa?.totpEnabled) };
};

export const User = mongoose.model('User', userSchema, 'users');
