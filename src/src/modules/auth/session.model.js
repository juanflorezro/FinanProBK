import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref } from '../../db/types.js';

const sessionSchema = createSchema({
  userId: ref('User', { required: true }),
  refreshTokenHash: { type: String, required: true },
  ip: String,
  userAgent: String,
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  replacedById: ref('Session'),
}, { tenant: false, optimisticConcurrency: false });

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo las borra solas al vencer

export const Session = mongoose.model('Session', sessionSchema, 'sessions');
