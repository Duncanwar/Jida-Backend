import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_MIN: z.coerce.number().positive().default(15),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  UPLOAD_DIR: z.string().default("./uploads"),
  BACKUP_DIR: z.string().default("./backups"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  /// Public base URL of the Next.js frontend. Used to build the links inside
  /// verification / password-reset emails, so it must be the address the user
  /// actually browses to — not the API origin.
  APP_URL: z.string().url().default("http://localhost:3000"),

  /// FR-AUTH-1 — verification link lifetime, in hours.
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().positive().default(24),
  /// Minimum gap between "resend verification" emails, in seconds.
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC: z.coerce.number().nonnegative().default(60),
  /// Maximum verification emails per address per token lifetime.
  EMAIL_VERIFICATION_MAX_SENDS: z.coerce.number().positive().default(5),

  /// FR-AUTH-2 — Google Identity Services. Leave GOOGLE_CLIENT_ID empty to
  /// disable Google sign-in entirely; the endpoint then returns 501.
  GOOGLE_CLIENT_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

/** True when Google sign-in is configured for this deployment (FR-AUTH-2). */
export const googleAuthEnabled = Boolean(env.GOOGLE_CLIENT_ID);
