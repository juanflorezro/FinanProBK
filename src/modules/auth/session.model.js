import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref } from '../../db/types.js';

const sessionSchema = createSchema({
  kind: { type: String, enum: ['user', 'admin'], default: 'user' }, // admin → userId apunta a PlatformAdmin
  userId: { type: 'ObjectId', required: true },
  refreshTokenHash: { type: String, required: true },
  ip: String,
  userAgent: String,
  expiresAt: { type: Date, required: true },
  familyStartedAt: Date, // cuándo se inició sesión (se conserva al rotar) para el tope absoluto
  revokedAt: Date,
  replacedById: ref('Session'),
}, { tenant: false, optimisticConcurrency: false });

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo las borra solas al vencer

export const Session = mongoose.model('Session', sessionSchema, 'sessions');
