import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate } from './middlewares/authenticate.js';
import { loadOrg } from './middlewares/loadOrg.js';
import { tenantContext } from './middlewares/tenantContext.js';
import { requireActiveOrg } from './middlewares/orgStatus.js';
import authRoutes from './modules/auth/auth.routes.js';
import organizationRoutes from './modules/organizations/organization.routes.js';
import borrowerRoutes from './modules/borrowers/borrower.routes.js';
import cashRoutes from './modules/cash/cash.routes.js';
import loanRoutes from './modules/loans/loan.routes.js';
import paymentRoutes from './modules/payments/payment.routes.js';
import memberRoutes from './modules/users/members.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import supportRoutes from './modules/support/support.routes.js';
import exportRoutes from './modules/exports/export.routes.js';
import portalRoutes from './modules/portal/portal.routes.js';
import globalPortalRoutes from './modules/portal/globalPortal.routes.js';
import { oauthApp } from './modules/oauth/oauth.routes.js';
import mcpRoutes from './modules/mcp/mcp.routes.js';
import { env } from './config/env.js';
import { runDailyAccrual } from './jobs/dailyAccrual.js';
import { checkSubscriptions } from './jobs/subscriptionCheck.js';
import adminAuthRoutes from './modules/platform/adminAuth.routes.js';
import adminRoutes from './modules/platform/admin.routes.js';

const api = Router();

// Vercel Cron llama esto una vez al día con Authorization: Bearer CRON_SECRET
api.get('/cron/daily', async (req, res) => {
  if (!env.CRON_SECRET || req.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  const accrual = await runDailyAccrual(new Date());
  const subscriptions = await checkSubscriptions();
  res.json({ ok: true, accrual: { orgs: accrual.orgs, loans: accrual.loans, errors: accrual.errors.length }, subscriptions });
});

api.get('/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'up' : 'down', time: new Date().toISOString() });
});

// Públicas (con límite de intentos)
api.use('/auth', authRoutes);

// Portal público del deudor: /api/portal/:slug/...
api.use('/portal-global', globalPortalRoutes);

// MCP para ChatGPT/Claude (OAuth) y la autorización desde la app
api.use('/oauth', oauthApp);
api.use('/mcp', mcpRoutes);
api.use('/portal/:slug', portalRoutes);

// Panel de administrador de la plataforma
api.use('/admin/auth', adminAuthRoutes);
api.use('/admin', adminRoutes);

// Requieren sesión pero no organización
api.use('/orgs', authenticate, organizationRoutes);

// Requieren sesión + organización (header X-Org-Id). Todo aquí queda aislado por orgId.
const orgScope = [authenticate, loadOrg, tenantContext, requireActiveOrg];
api.use('/borrowers', ...orgScope, borrowerRoutes);
api.use('/cash-accounts', ...orgScope, cashRoutes);
api.use('/loans', ...orgScope, loanRoutes);
api.use('/payments', ...orgScope, paymentRoutes);
api.use('/members', ...orgScope, memberRoutes);
api.use('/dashboard', ...orgScope, dashboardRoutes);
// Configuración: se puede ver aunque la org esté en solo lectura
api.use('/settings', authenticate, loadOrg, tenantContext, settingsRoutes);
// Soporte y exportaciones: disponibles aunque la org esté en solo lectura o suspendida
api.use('/support', authenticate, loadOrg, tenantContext, supportRoutes);
api.use('/exports', authenticate, loadOrg, tenantContext, exportRoutes);

export default api;
