import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

const authIdentitySchema = createSchema({
  userId: ref('User', { required: true }),
  provider: enumOf(['google', 'password'], { required: true }),
  providerUid: { type: String, required: true }, // sub de Google o email
  passwordHash: { type: String, select: false },
  passwordUpdatedAt: Date,
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: Date,
  lastUsedAt: Date,
}, { tenant: false });

authIdentitySchema.index({ provider: 1, providerUid: 1 }, { unique: true });
authIdentitySchema.index({ userId: 1 });

export const AuthIdentity = mongoose.model('AuthIdentity', authIdentitySchema, 'auth_identities');
