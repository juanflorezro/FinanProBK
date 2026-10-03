import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';

let Borrower, CashAccount, runWithContext;

beforeAll(async () => {
  Object.assign(process.env, {
    MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 'test',
  });
  ({ Borrower } = await import('../src/modules/borrowers/borrower.model.js'));
  ({ CashAccount } = await import('../src/modules/cash/cashAccount.model.js'));
  ({ runWithContext } = await import('../src/db/context.js'));
});

describe('aislamiento por organización', () => {
  it('asigna el orgId del contexto antes de validar', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await runWithContext({ orgId }, async () => {
      const cash = new CashAccount({ name: 'Principal' });
      await cash.validate();
      expect(String(cash.orgId)).toBe(String(orgId));
      const b = new Borrower({ code: 'C1', docType: 'CC', docNumber: '123456', docNumberHash: 'h', firstName: 'A', lastName: 'B', phone: '3001234567' });
      await b.validate();
      expect(String(b.orgId)).toBe(String(orgId));
    });
  });

  it('sin contexto no deja crear', async () => {
    await expect(new CashAccount({ name: 'X' }).validate()).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
  });
});
