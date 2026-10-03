import mongoose from 'mongoose';
import { createSchema } from '../../db/createSchema.js';

const counterSchema = createSchema({
  key: { type: String, required: true },   // borrower | loan | receipt
  prefix: { type: String, default: '' },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ orgId: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model('Counter', counterSchema);

/** Consecutivo atómico por organización. Pasa la session si estás en transacción. */
export async function nextSeq(orgId, key, session) {
  const doc = await Counter.findOneAndUpdate(
    { orgId, key },
    { $inc: { seq: 1 }, $setOnInsert: { orgId, key } },
    { returnDocument: 'after', upsert: true, session },
  );
  return `${doc.prefix}${String(doc.seq).padStart(6, '0')}`;
}
