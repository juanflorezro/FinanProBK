// Roles del sistema y sus permisos. '*' = todo; 'recurso.*' = todo sobre el recurso.
export const ROLES = {
  owner: ['*'],
  admin: ['borrower.*', 'loan.*', 'payment.*', 'cash.*', 'member.*', 'export.*', 'org.read', 'org.update'],
  analista: ['borrower.*', 'loan.read', 'loan.create', 'loan.update', 'loan.disburse', 'payment.read', 'payment.create', 'cash.read', 'export.create'],
  cobrador: ['borrower.read', 'loan.read', 'payment.read', 'payment.create', 'cash.read'],
  auditor: ['*.read', 'export.create'],
};

export const ROLE_NAMES = Object.keys(ROLES);

export function hasPermission(role, permission) {
  const granted = ROLES[role] ?? [];
  const [resource, action] = permission.split('.');
  return granted.some((p) => p === '*' || p === permission || p === `${resource}.*` || (p === '*.read' && action === 'read'));
}
