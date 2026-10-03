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

const api = Router();

api.get('/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'up' : 'down', time: new Date().toISOString() });
});

// Públicas (con límite de intentos)
api.use('/auth', authRoutes);

// Requieren sesión pero no organización
api.use('/orgs', authenticate, organizationRoutes);

// Requieren sesión + organización (header X-Org-Id). Todo aquí queda aislado por orgId.
const orgScope = [authenticate, loadOrg, tenantContext, requireActiveOrg];
api.use('/borrowers', ...orgScope, borrowerRoutes);
api.use('/cash-accounts', ...orgScope, cashRoutes);
api.use('/loans', ...orgScope, loanRoutes);
api.use('/payments', ...orgScope, paymentRoutes);
api.use('/members', ...orgScope, memberRoutes);

export default api;
