/** Bloquea escrituras si la organización no está activa: deja ver y exportar. */
export function requireActiveOrg(req, res, next) {
  const status = req.org?.status;
  if (status === 'activa') return next();
  if (status === 'archivada') return res.status(403).json({ error: 'ORG_ARCHIVED' });
  if (req.method === 'GET' || req.path.startsWith('/exports')) return next();
  return res.status(423).json({ error: 'ORG_READ_ONLY', status });
}
