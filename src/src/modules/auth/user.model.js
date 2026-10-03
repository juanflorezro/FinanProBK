import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

const userSchema = createSchema({
  email: { type: String, required: true, lowercase: true, trim: true },
  emailVerified: { type: Boolean, default: false },
  name: { type: String, trim: true },
  avatarUrl: String,
  phone: String,
  status: enumOf(['activo', 'bloqueado'], { default: 'activo' }),
  defaultOrgId: ref('Organization'),
  lastLoginAt: Date,
}, { tenant: false });

userSchema.index({ email: 1 }, { unique: true });

userSchema.methods.toPublic = function () {
  return { id: this._id, email: this.email, name: this.name, avatarUrl: this.avatarUrl, emailVerified: this.emailVerified, defaultOrgId: this.defaultOrgId };
};

export const User = mongoose.model('User', userSchema, 'users');
