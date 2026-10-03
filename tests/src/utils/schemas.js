import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Id inválido');

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Dinero en centavos: entero positivo. */
export const cents = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Tasa como texto o número → string decimal, sin tope. */
export const rateValue = z.union([z.string(), z.number()])
  .transform(String)
  .refine((v) => /^\d+(\.\d{1,8})?$/.test(v), 'Tasa inválida');
