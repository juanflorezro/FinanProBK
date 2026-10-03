import { httpError } from '../utils/errors.js';

/**
 * validate({ body, query, params }) con esquemas zod.
 * El resultado queda en req.valid (en Express 5 req.query no se puede reasignar).
 */
export function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid ?? {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        return next(httpError(400, 'VALIDATION_ERROR', 'Datos inválidos', result.error.issues.map((i) => ({
          field: [part, ...i.path].join('.'), message: i.message,
        }))));
      }
      req.valid[part] = result.data;
    }
    next();
  };
}
