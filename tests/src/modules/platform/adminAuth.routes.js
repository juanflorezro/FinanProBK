import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { isProd, env } from '../../config/env.js';
import { validate } from '../../middlewares/validate.js';
import { authenticateAdmin } from '../../middlewares/adminAuth.js';
import { adminLogin, adminLoginVerify, adminRefresh, adminLogout } from './adminAuth.service.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const COOKIE = 'art';
const cookieOptions = () => ({
  httpOnly: true,
  secure: isProd || env.COOKIE_SAMESITE === 'none',
  sameSite: env.COOKIE_SAMESITE,
  path: '/api/admin/auth',
  maxAge: 12 * 3_600_000,
});
const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const send = (res, { admin, accessToken, refreshToken }) => {
  res.cookie(COOKIE, refreshToken, cookieOptions());
  res.json({ accessToken, admin: admin.toPublic() });
};

router.post('/login', limiter, validate({
  body: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }),
}), async (req, res) => {
  res.json(await adminLogin(req.valid.body));
});

router.post('/login/verify', limiter, validate({
  body: z.object({ mfaToken: z.string().min(20), code: z.string().trim().regex(/^\d{6}$/) }),
}), async (req, res) => {
  send(res, await adminLoginVerify(req.valid.body, meta(req)));
});

router.post('/refresh', limiter, async (req, res) => {
  send(res, await adminRefresh(req.cookies?.[COOKIE], meta(req)));
});

router.post('/logout', async (req, res) => {
  await adminLogout(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

router.get('/me', authenticateAdmin, (req, res) => res.json({ admin: req.admin.toPublic() }));

export default router;
