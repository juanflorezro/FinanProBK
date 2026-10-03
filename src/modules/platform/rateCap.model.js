import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';
import { rate, enumOf } from '../../db/types.js';

export const CAP_MODALITIES = ['consumo', 'bajo_monto', 'microcredito', 'comercial', 'otro'];

// Tasa máxima legal por país, modalidad y período. Solo aplica a organizaciones acogidas a la ley.
const rateCapSchema = createSchema({
  country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2 },
  modality: enumOf(CAP_MODALITIES, { default: 'consumo' }),
  maxAnnualEffectiveRate: rate({ required: true }), // % efectivo anual, ej. "29.66"
  validFrom: { type: Date, required: true },
  validTo: { type: Date, default: null },
  sourceResolution: { type: String, trim: true }, // ej. "Resolución Superfinanciera 1234 de 2026"
  notes: String,
}, { tenant: false });

rateCapSchema.index({ country: 1, modality: 1, validFrom: -1 });

/** Tope vigente en una fecha. */
rateCapSchema.statics.currentFor = function (country, modality, at = new Date()) {
  return this.findOne({
    country: country.toUpperCase(),
    modality,
    validFrom: { $lte: at },
    $or: [{ validTo: null }, { validTo: { $gte: at } }],
  }).sort({ validFrom: -1 });
};

export const RateCap = mongoose.model('RateCap', rateCapSchema, 'rate_caps');
