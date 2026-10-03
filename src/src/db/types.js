import mongoose from 'mongoose';

const { ObjectId, Decimal128 } = mongoose.Schema.Types;

// Dinero: entero en centavos. 1.000.000 COP = 100000000
export const money = (opts = {}) => ({
  type: Number,
  default: 0,
  validate: {
    validator: Number.isSafeInteger,
    message: '{PATH} debe ser un entero en centavos',
  },
  ...opts,
});

// Tasas: Decimal128 para no perder precisión; se lee como string
export const rate = (opts = {}) => ({
  type: Decimal128,
  get: (v) => (v == null ? v : v.toString()),
  ...opts,
});

export const ref = (model, opts = {}) => ({ type: ObjectId, ref: model, ...opts });

export const enumOf = (values, opts = {}) => ({ type: String, enum: values, ...opts });
