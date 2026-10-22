import { and, eq, lt, sql } from 'drizzle-orm';
import { apiRateLimits } from './schema.js';
import { db, memoryStore } from './database.js';
import { setTenantContext } from './tenant-context.js';

export async function consumeRateLimit({ userId, scope, limit, windowMs, now = Date.now() }) {
  const bucketNumber = Math.floor(now / windowMs);
  const key = `${userId}:${scope}:${bucketNumber}`;
  const resetAt = (bucketNumber + 1) * windowMs;
  let count;

  if (memoryStore) {
    const current = memoryStore.rateLimitBuckets.get(key) || 0;
    count = current + 1;
    memoryStore.rateLimitBuckets.set(key, count);
  } else {
    count = await db.transaction(async (tx) => {
      await setTenantContext(tx, userId);
      const [row] = await tx.insert(apiRateLimits)
        .values({ bucketKey: key, userId, requestCount: 1, expiresAt: new Date(resetAt + windowMs) })
        .onConflictDoUpdate({
          target: apiRateLimits.bucketKey,
          set: { requestCount: sql`${apiRateLimits.requestCount} + 1` },
        })
        .returning({ count: apiRateLimits.requestCount });

      await tx.delete(apiRateLimits).where(and(eq(apiRateLimits.userId, userId), lt(apiRateLimits.expiresAt, new Date(now))));
      return row.count;
    });
  }

  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt };
}
