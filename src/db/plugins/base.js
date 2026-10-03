import { getContext } from '../context.js';

/**
 * Campos comunes: createdBy, updatedBy, deletedAt (borrado lógico).
 * Los timestamps se activan en el schema con { timestamps: true }.
 */
export function basePlugin(schema) {
  schema.add({
    createdBy: { type: 'ObjectId', ref: 'User' },
    updatedBy: { type: 'ObjectId', ref: 'User' },
    deletedAt: { type: Date, default: null, index: true },
  });

  schema.pre('save', async function () {
    const { userId } = getContext();
    if (!userId) return;
    if (this.isNew) this.createdBy ??= userId;
    this.updatedBy = userId;
  });

  // Excluye borrados lógicos salvo .setOptions({ withDeleted: true })
  schema.pre(['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany'], async function () {
    if (this.getOptions().withDeleted) return;
    if (this.getFilter().deletedAt === undefined) this.where({ deletedAt: null });

    const { userId } = getContext();
    const update = this.getUpdate?.();
    if (update && userId) {
      update.$set = { ...(update.$set ?? {}), updatedBy: userId };
    }
  });

  schema.methods.softDelete = function () {
    this.deletedAt = new Date();
    return this.save();
  };
}
export default basePlugin;
