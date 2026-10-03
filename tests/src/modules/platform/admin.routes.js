import { Router } from 'express';
import { authenticateAdmin, adminRole } from '../../middlewares/adminAuth.js';
import dashboardRoutes from './admin.dashboard.routes.js';
import planRoutes from './admin.plans.routes.js';
import tenantRoutes from './admin.tenants.routes.js';
import organizationRoutes from './admin.organizations.routes.js';
import auditRoutes from './admin.audit.routes.js';
import adminRoutes from './admin.admins.routes.js';

// Todo bajo /api/admin requiere sesión de administrador de plataforma.
const router = Router();
router.use(authenticateAdmin);

router.use('/dashboard', dashboardRoutes);
router.use('/plans', planRoutes);
router.use('/tenants', adminRole('finanzas', 'soporte'), tenantRoutes);
router.use('/organizations', adminRole('soporte', 'finanzas'), organizationRoutes);
router.use('/audit', adminRole('soporte'), auditRoutes);
router.use('/admins', adminRole(), adminRoutes);

export default router;
