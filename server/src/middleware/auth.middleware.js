import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual, createHash } from 'node:crypto';
import { config } from '../config/env.js';

let jwks;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(config.neonAuthJwksUrl));
  return jwks;
}

// Test-only key injection exercises signature checks without a network JWKS call.
export function setJwksProviderForTests(provider) {
  if (!config.isTestMode) throw new Error('JWKS injection is available only in test mode.');
  jwks = provider;
}

/** Verify Neon Auth JWTs and attach only the signed subject claim. */
export async function requireUser(req, res, next) {
  const match = (req.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);

  if (config.isTestMode) {
    const expectedHash = createHash('sha256').update('test-api-token').digest();
    const actualHash = createHash('sha256').update(req.get('X-Smart-Web-Token') || '').digest();
    if (timingSafeEqual(expectedHash, actualHash)) {
      req.user = { id: req.get('X-Test-User') || '00000000-0000-4000-8000-000000000001' };
      return next();
    }
    if (!match) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED', requestId: req.id });
    }
  }

  if (!match) return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED', requestId: req.id });
  let payload;
  try {
    ({ payload } = await jwtVerify(match[1], getJwks(), { issuer: config.neonAuthBaseUrl }));
    const isUuid = typeof payload.sub === 'string'
      && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(payload.sub);
    if (!isUuid || typeof payload.exp !== 'number') {
      return res.status(401).json({ error: 'Invalid or expired session.', code: 'AUTH_INVALID', requestId: req.id });
    }
  } catch (error) {
    const unavailable = error.name === 'TypeError' || error.code === 'ERR_JWKS_TIMEOUT';
    return res.status(unavailable ? 503 : 401).json({
      error: unavailable ? 'Authentication service is temporarily unavailable.' : 'Invalid or expired session.',
      code: unavailable ? 'AUTH_UNAVAILABLE' : 'AUTH_INVALID',
      requestId: req.id,
    });
  }

  req.user = { id: payload.sub };
  return next();
}
