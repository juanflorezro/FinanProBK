import { describe, it, expect, beforeAll, vi } from 'vitest';

let checkRateCompliance, RateCap;

beforeAll(async () => {
  Object.assign(process.env, {
    MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32), DATA_HASH_SECRET: 'c'.repeat(32), GOOGLE_CLIENT_ID: 'test',
  });
  ({ checkRateCompliance } = await import('../src/modules/loans/rateCompliance.js'));
  ({ RateCap } = await import('../src/modules/platform/rateCap.model.js'));
});

const cap = { _id: 'cap1', maxAnnualEffectiveRate: '29.66', sourceResolution: 'Res. prueba' };
const org = (cfg) => ({ country: 'CO', settings: { legalRateCompliance: cfg } });
const informal = { rate: '20', rateBasis: 'mensual', rateKind: 'efectiva', frequency: 'mensual' }; // 791% EA
const formal = { rate: '1.8', rateBasis: 'mensual', rateKind: 'efectiva', frequency: 'mensual' };  // 23.9% EA

describe('tasa legal', () => {
  it('organización no acogida: tasa libre', async () => {
    expect(await checkRateCompliance({ org: org({ enabled: false }), loan: informal })).toEqual({ rateCapCheck: 'no_aplica' });
  });

  it('acogida y dentro del tope', async () => {
    vi.spyOn(RateCap, 'currentFor').mockResolvedValue(cap);
    const r = await checkRateCompliance({ org: org({ enabled: true, policy: 'bloquear', modality: 'consumo' }), loan: formal });
    expect(r.rateCapCheck).toBe('dentro');
  });

  it('acogida con política bloquear rechaza 20% mensual', async () => {
    vi.spyOn(RateCap, 'currentFor').mockResolvedValue(cap);
    await expect(checkRateCompliance({ org: org({ enabled: true, policy: 'bloquear' }), loan: informal }))
      .rejects.toMatchObject({ code: 'RATE_ABOVE_LEGAL_CAP', status: 422 });
  });

  it('acogida con política advertir pide confirmación y la registra', async () => {
    vi.spyOn(RateCap, 'currentFor').mockResolvedValue(cap);
    const o = org({ enabled: true, policy: 'advertir' });
    await expect(checkRateCompliance({ org: o, loan: informal })).rejects.toMatchObject({ code: 'RATE_CAP_ACK_REQUIRED' });
    const r = await checkRateCompliance({ org: o, loan: informal, acknowledge: true, membershipId: 'm1' });
    expect(r).toMatchObject({ rateCapCheck: 'excede_confirmado', rateCapAckBy: 'm1' });
  });
});
