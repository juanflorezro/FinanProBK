import { describe, it, expect, beforeAll } from 'vitest';
import { generateSecret, generateSync } from 'otplib';

let verifySecondFactor, signMfaToken, readMfaToken, encrypt, decrypt, hmac, User, verifyAccessToken, signAccessToken;

beforeAll(async () => {
  Object.assign(process.env, {
    MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 'test',
  });
  ({ verifySecondFactor, signMfaToken, readMfaToken } = await import('../src/modules/auth/mfa.service.js'));
  ({ encrypt, decrypt, hmac } = await import('../src/utils/crypto.js'));
  ({ User } = await import('../src/modules/auth/user.model.js'));
  ({ verifyAccessToken, signAccessToken } = await import('../src/modules/auth/tokens.js'));
});

function userWithTotp(secret, backup = []) {
  return new User({
    email: 'a@b.co',
    mfa: {
      totpEnabled: true,
      totpSecret: encrypt(secret),
      backupCodes: backup.map((c) => hmac(`backup:${c.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`)),
    },
  });
}

describe('2FA', () => {
  it('cifra y descifra el secreto', () => {
    const enc = encrypt('MISECRETO');
    expect(enc).not.toContain('MISECRETO');
    expect(decrypt(enc)).toBe('MISECRETO');
  });

  it('acepta el código de la app una sola vez', () => {
    const secret = generateSecret();
    const user = userWithTotp(secret);
    const code = generateSync({ secret });
    expect(verifySecondFactor(user, code)).toBe(true);
    expect(verifySecondFactor(user, code)).toBe(false); // reutilizado
    expect(verifySecondFactor(user, '000000')).toBe(false);
  });

  it('código de respaldo funciona una vez', () => {
    const user = userWithTotp(generateSecret(), ['ABCDE-12345']);
    expect(verifySecondFactor(user, 'abcde12345')).toBe(true);
    expect(verifySecondFactor(user, 'ABCDE-12345')).toBe(false);
  });

  it('el token de 2FA no sirve como token de acceso y viceversa', () => {
    const user = new User({ email: 'a@b.co' });
    const mfa = signMfaToken(user, 'email');
    expect(readMfaToken(mfa).method).toBe('email');
    expect(() => verifyAccessToken(mfa)).toThrow();
    expect(() => readMfaToken(signAccessToken(user))).toThrow();
  });
});
