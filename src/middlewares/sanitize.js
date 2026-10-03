// Elimina claves que empiezan por $ o contienen punto (inyección NoSQL).
// Compatible con Express 5. req.query se valida aparte con zod.
function strip(obj) {
  if (Array.isArray(obj)) return obj.forEach(strip);
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) delete obj[key];
    else strip(obj[key]);
  }
}

export function sanitize(req, _res, next) {
  strip(req.body);
  strip(req.params);
  next();
}
