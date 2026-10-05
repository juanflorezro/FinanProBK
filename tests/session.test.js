import { describe, it, expect, beforeAll, vi } from 'vitest';
import mongoose from 'mongoose';

let refreshSession, Session, User;
const user = { _id: new mongoose.Types.ObjectId(), status: 'activo', toPublic: () => ({}) };
beforeAll(async () => {
  Object.assign(process.env, { MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 't' });
  ({ refreshSession } = await import('../src/modules/auth/auth.service.js'));
  ({ Session } = await import('../src/modules/auth/session.model.js'));
  ({ User } = await import('../src/modules/auth/user.model.js'));
  vi.spyOn(User, 'findById').mockResolvedValue(user);
  vi.spyOn(Session, 'create').mockImplementation(async (d) => ({ ...d, _id: new mongoose.Types.ObjectId() }));
  vi.spyOn(Session, 'updateMany').mockResolvedValue({});
});
const row = (extra) => ({ userId: user._id, expiresAt: new Date(Date.now() + 3_600_000), familyStartedAt: new Date(), save: async () => {}, ...extra });

describe('sesión', () => {
  it('recarga rápida con el mismo token (rotado hace segundos) no cierra la sesión', async () => {
    vi.spyOn(Session, 'findOne').mockResolvedValueOnce(row({ revokedAt: new Date(Date.now() - 5_000), replacedById: new mongoose.Types.ObjectId() }));
    const r = await refreshSession('token-viejo', {});
    expect(r.accessToken).toBeTruthy();
    expect(Session.updateMany).not.toHaveBeenCalled();
  });

  it('un token reusado mucho después se toma como robo y cierra todo', async () => {
    vi.spyOn(Session, 'findOne').mockResolvedValueOnce(row({ revokedAt: new Date(Date.now() - 600_000), replacedById: new mongoose.Types.ObjectId() }));
    await expect(refreshSession('robado', {})).rejects.toMatchObject({ code: 'SESSION_REUSED' });
  });

  it('vence por inactividad', async () => {
    vi.spyOn(Session, 'findOne').mockResolvedValueOnce(row({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(refreshSession('viejo', {})).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('refrescar la extiende 48 horas y conserva el inicio de la sesión', async () => {
    const started = new Date(Date.now() - 10 * 86_400_000);
    vi.spyOn(Session, 'findOne').mockResolvedValueOnce(row({ familyStartedAt: started }));
    await refreshSession('vigente', {});
    const created = Session.create.mock.calls.at(-1)[0];
    expect(created.familyStartedAt).toEqual(started);
    expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
  });
});
