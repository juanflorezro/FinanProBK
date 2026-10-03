import { HttpError } from '../utils/errors.js';

export function notFound(req, _res, next) {
  next(new HttpError(404, 'NOT_FOUND', `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = err.status ?? 500;
  let code = err.code;
  let message = err.message;
  let details = err.details;

  if (err.name === 'ValidationError') {
    status = 400; code = 'VALIDATION_ERROR'; message = 'Datos inválidos';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err.name === 'CastError') {
    status = 400; code = 'INVALID_ID'; message = `Valor inválido para ${err.path}`;
  } else if (err.name === 'VersionError') {
    status = 409; code = 'CONCURRENT_UPDATE'; message = 'El registro cambió mientras lo editabas, vuelve a intentarlo';
  } else if (err.code === 11000) {
    status = 409; code = 'DUPLICATE'; message = 'Ya existe un registro con esos datos';
    details = err.keyValue;
  } else if (err.type === 'entity.parse.failed') {
    status = 400; code = 'INVALID_JSON'; message = 'JSON inválido';
  }

  if (typeof code !== 'string') code = status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  if (status >= 500) {
    req.log?.error({ err }, 'Error no controlado');
    message = 'Error interno, intenta de nuevo';
    details = undefined;
  }
  res.status(status).json({ error: code, message, ...(details && { details }), requestId: req.id });
}
