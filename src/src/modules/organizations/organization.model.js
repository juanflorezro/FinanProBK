import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

export const ORG_STATUS = ['activa', 'solo_lectura', 'suspendida', 'archivada'];

const settingsSchema = new mongoose.Schema({
  paymentWaterfall: { type: [String], default: ['mora', 'cargo', 'interes', 'capital'] },
  graceDays: { type: Number, default: 0 },
  receiptPrefix: { type: String, default: '' },
  loanPrefix: { type: String, default: 'P' },
  portalEnabled: { type: Boolean, default: true },
  portalOtpChannel: enumOf(['sms', 'whatsapp', 'email'], { default: 'sms' }),
  allowedRegimes: { type: [String], default: ['formal', 'informal'] },
}, { _id: false });

const organizationSchema = createSchema({
  tenantAccountId: ref('TenantAccount', { required: true }),
  ownerUserId: ref('User', { required: true }),
  slug: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  legalName: String,
  taxId: String,
  country: { type: String, default: 'CO', uppercase: true },
  currency: { type: String, default: 'COP', uppercase: true },
  timezone: { type: String, default: 'America/Bogota' },
  locale: { type: String, default: 'es-CO' },
  logoUrl: String,
  status: enumOf(ORG_STATUS, { default: 'activa' }),
  statusReason: String,
  statusChangedAt: Date,
  settings: { type: settingsSchema, default: () => ({}) },
}, { tenant: false });

organizationSchema.index({ slug: 1 }, { unique: true });
organizationSchema.index({ tenantAccountId: 1 });

export const Organization = mongoose.model('Organization', organizationSchema, 'organizations');
