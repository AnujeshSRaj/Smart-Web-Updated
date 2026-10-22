export class AppError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message, options);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

export function createError(statusCode, message, code = 'REQUEST_FAILED') {
  return new AppError(statusCode, code, message);
}
