import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { enumOf } from '../../db/types.js';

// Un código activo por correo y propósito. Se borra solo 1 hora después de vencer.
const verificationSchema = createSchema({
  email: { type: String, required: true, lowercase: true, trim: true },
  purpose: enumOf(['verify_email', 'reset_password', 'login_2fa', 'admin_login'], { required: true }),
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  lastSentAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
}, { tenant: false, optimisticConcurrency: false });

verificationSchema.index({ email: 1, purpose: 1 }, { unique: true });
verificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const Verification = mongoose.model('Verification', verificationSchema, 'verifications');
