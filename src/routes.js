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
import adminAuthRoutes from './modules/platform/adminAuth.routes.js';
import adminRoutes from './modules/platform/admin.routes.js';

const api = Router();

api.get('/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'up' : 'down', time: new Date().toISOString() });
});

// Públicas (con límite de intentos)
api.use('/auth', authRoutes);

// Portal público del deudor: /api/portal/:slug/...
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
