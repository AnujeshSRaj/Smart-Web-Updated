import { sql } from 'drizzle-orm';

/** Set the verified identity only for the lifetime of the current transaction. */
export async function setTenantContext(tx, userId) {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}
