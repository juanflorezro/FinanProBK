import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, enumOf } from '../../db/types.js';

// 0 en un límite = sin límite
const planSchema = createSchema({
  code: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: String,
  price: money({ required: true }),
  currency: { type: String, default: 'COP', uppercase: true },
  billingCycle: enumOf(['mensual', 'trimestral', 'anual'], { default: 'mensual' }),
  limits: {
    maxUsers: { type: Number, default: 0 },
    maxBorrowers: { type: Number, default: 0 },
    maxActiveLoans: { type: Number, default: 0 },
  },
  features: [String],
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { tenant: false });

planSchema.index({ code: 1 }, { unique: true });

export const CYCLE_MONTHS = { mensual: 1, trimestral: 3, anual: 12 };
export const Plan = mongoose.model('Plan', planSchema, 'plans');
