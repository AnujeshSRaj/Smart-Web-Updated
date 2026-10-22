import { config } from '../config/env.js';
import { consumeRateLimit } from '../db/rate-limits.js';

const WINDOW_MS = 60_000;

function policyFor(req) {
  if (req.method === 'POST' && req.path === '/chat') {
    return { scope: 'chat', limit: config.rateLimits.chatPerMinute };
  }
  if (req.method === 'GET') {
    return { scope: 'read', limit: config.rateLimits.readPerMinute };
  }
  return { scope: 'write', limit: config.rateLimits.writePerMinute };
}

/** Shared, per-user limits backed by Postgres; fails closed when the store is unavailable. */
export async function apiRateLimiter(req, res, next) {
  try {
    const { scope, limit } = policyFor(req);
    const result = await consumeRateLimit({
      userId: req.user.id,
      scope,
      limit: config.isTestMode ? Math.max(limit, 1000) : limit,
      windowMs: WINDOW_MS,
    });
    res.set({
      'RateLimit-Limit': String(result.limit),
      'RateLimit-Remaining': String(result.remaining),
      'RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
    });
    if (!result.allowed) {
      return res.status(429).json({
        error: 'Request limit reached. Try again after the reset time.',
        code: 'RATE_LIMITED',
        requestId: req.id,
      });
    }
    return next();
  } catch (error) {
    const unavailable = new Error('Rate limit service is temporarily unavailable.', { cause: error });
    unavailable.statusCode = 503;
    unavailable.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
    return next(unavailable);
  }
}

export { policyFor };
