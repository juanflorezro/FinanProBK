import mongoose from 'mongoose';

/**
 * Ejecuta fn(session) en una transacción. Reintenta solo ante errores transitorios.
 * Uso: await withTransaction(async (session) => { ...; await doc.save({ session }); });
 */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}
