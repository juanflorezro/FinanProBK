import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { ref, enumOf } from '../../db/types.js';

// Cliente de la plataforma (registro previo que hace el admin).
const tenantAccountSchema = createSchema({
  legalName: { type: String, required: true, trim: true },
  tradeName: { type: String, trim: true },
  taxIdType: { type: String, default: 'NIT' },
  taxId: { type: String, trim: true },
  country: { type: String, default: 'CO', uppercase: true },
  contactName: String,
  contactEmail: { type: String, required: true, lowercase: true, trim: true },
  contactPhone: String,
  address: String,
  city: String,
  status: enumOf(['prospecto', 'pendiente_pago', 'habilitado', 'activo', 'suspendido', 'cancelado'], { default: 'prospecto' }),
  source: String,
  approvedBy: ref('PlatformAdmin'),
  approvedAt: Date,
  internalNotes: String,
}, { tenant: false });

tenantAccountSchema.index({ contactEmail: 1 }, { unique: true });
tenantAccountSchema.index({ taxId: 1 }, { unique: true, partialFilterExpression: { taxId: { $type: 'string' } } });

export const TenantAccount = mongoose.model('TenantAccount', tenantAccountSchema, 'tenant_accounts');
