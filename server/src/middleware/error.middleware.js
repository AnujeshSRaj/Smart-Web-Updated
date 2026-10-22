import { ZodError } from 'zod';
import { config } from '../config/env.js';

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err instanceof ZodError ? 400 : (err.statusCode || err.status || 500);
  const code = err instanceof ZodError ? 'VALIDATION_ERROR' : (err.code || 'INTERNAL_ERROR');
  const requestId = req.id || 'unknown';

  console.error(JSON.stringify({
    level: status >= 500 ? 'error' : 'warn',
    event: 'http.request.failed',
    requestId,
    method: req.method,
    path: req.path,
    status,
    code,
    errorName: err.name,
    ...(config.isDev && { message: err.message, stack: err.stack }),
  }));

  const message = err instanceof ZodError
    ? 'Validation error'
    : (status < 500 || config.isDev ? err.message : 'An unexpected error occurred');
  return res.status(status).json({
    error: message,
    code,
    requestId,
    ...(err instanceof ZodError && {
      details: err.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    }),
    ...(config.isDev && status === 500 && { detail: err.message }),
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}`, code: 'ROUTE_NOT_FOUND', requestId: req.id });
}
