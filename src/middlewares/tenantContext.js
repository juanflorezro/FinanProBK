import { runWithContext } from '../db/context.js';

// Va DESPUÉS del middleware de auth, que deja req.user y req.membership
export function tenantContext(req, _res, next) {
  const ctx = {
    userId: req.user?._id,
    orgId: req.membership?.orgId,
    membershipId: req.membership?._id,
    requestId: req.id,
  };
  runWithContext(ctx, () => next());
}
