import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { z } from 'zod';
import { DEFAULT_GROQ_MODEL, SUPPORTED_GROQ_MODELS } from './models.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const isTestMode = process.env.NODE_ENV === 'test' || process.argv.some((arg) => arg.includes('test'));
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default(isTestMode ? 'test' : 'development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default(process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  DATABASE_URL: z.string().url().optional(),
  NEON_AUTH_BASE_URL: z.string().url().optional(),
  NEON_AUTH_JWKS_URL: z.string().url().optional(),
  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_MODEL: z.enum(SUPPORTED_GROQ_MODELS).default(DEFAULT_GROQ_MODEL),
  MAX_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(50000).default(10000),
  MAX_HISTORY_TURNS: z.coerce.number().int().min(1).max(50).default(10),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  RATE_LIMIT_CHAT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
  RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().min(1).max(1200).default(120),
  RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
  CORS_ORIGINS: z.string().default(''),
}).superRefine((env, ctx) => {
  if (!isTestMode) {
    for (const name of ['DATABASE_URL', 'NEON_AUTH_BASE_URL', 'NEON_AUTH_JWKS_URL']) {
      if (!env[name]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is required outside tests.` });
    }
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid server configuration: ${details}`);
}

const env = parsed.data;
export const config = Object.freeze({
  port: env.PORT,
  host: env.HOST,
  nodeEnv: env.NODE_ENV,
  isTestMode,
  isDev: env.NODE_ENV === 'development',
  databaseUrl: env.DATABASE_URL || 'postgresql://test:test@localhost/test',
  dbPoolMax: env.DB_POOL_MAX,
  rateLimits: Object.freeze({
    chatPerMinute: env.RATE_LIMIT_CHAT_PER_MINUTE,
    readPerMinute: env.RATE_LIMIT_READ_PER_MINUTE,
    writePerMinute: env.RATE_LIMIT_WRITE_PER_MINUTE,
  }),
  neonAuthBaseUrl: env.NEON_AUTH_BASE_URL || 'https://example.neon.tech/neondb/auth',
  neonAuthJwksUrl: env.NEON_AUTH_JWKS_URL || 'https://example.neon.tech/neondb/auth/.well-known/jwks.json',
  groq: { apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL },
  maxContextChars: env.MAX_CONTEXT_CHARS,
  maxHistoryTurns: env.MAX_HISTORY_TURNS,
  corsOrigins: env.CORS_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
});
