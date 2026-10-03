import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { money, ref, enumOf } from '../../db/types.js';

const borrowerSchema = createSchema({
  code: { type: String, required: true },
  docType: enumOf(['CC', 'CE', 'PPT', 'PAS', 'NIT'], { required: true }),
  docNumber: { type: String, required: true, trim: true },
  docNumberHash: { type: String, required: true, select: false },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  birthDate: Date,
  phone: { type: String, required: true },
  phoneAlt: String,
  email: { type: String, lowercase: true, trim: true },
  address: String,
  city: String,
  neighborhood: String,
  geo: { lat: Number, lng: Number },
  occupation: String,
  monthlyIncome: money(),
  riskRating: enumOf(['A', 'B', 'C', 'D'], { default: 'B' }),
  status: enumOf(['activo', 'inactivo', 'bloqueado'], { default: 'activo' }),
  assignedCollectorId: ref('Membership'),
  routeId: ref('CollectionRoute'),
});

borrowerSchema.index(
  { orgId: 1, docType: 1, docNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
borrowerSchema.index({ orgId: 1, code: 1 }, { unique: true });
borrowerSchema.index({ orgId: 1, docNumberHash: 1 });
borrowerSchema.index({ orgId: 1, lastName: 1, firstName: 1 });

borrowerSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

export const Borrower = mongoose.model('Borrower', borrowerSchema, 'borrowers');
