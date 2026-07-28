/**
 * Rate limiting for the credential and email endpoints.
 *
 * Without this, /login is an unbounded password-guessing oracle and
 * /resend-verification is a free way to use the journal's mail server to spam
 * a third party. Both are baseline expectations for a production deployment.
 *
 * The default store is per-process and in-memory; behind multiple instances,
 * swap in a shared store (e.g. rate-limit-redis) so the budget is global.
 */
import rateLimit, { type Options } from "express-rate-limit";
import { env } from "../config/env.js";

const isTest = env.NODE_ENV === "test";

function limiter(options: Partial<Options> & { max: number; windowMs: number }) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Tests assert on business logic, not on throttling.
    skip: () => isTest,
    ...options,
  });
}

/** Login / register / password reset — resists credential stuffing. */
export const authRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    error: "Too many attempts from this address. Please wait a few minutes and try again.",
    code: "RATE_LIMITED",
  },
});

/**
 * Verification endpoints. Slightly more generous than the auth limiter because
 * mail clients pre-fetch links, but still bounded. The per-user cooldown in
 * emailVerification.ts is the real throttle; this bounds it per IP as well.
 */
export const verificationRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    error: "Too many verification requests. Please wait a few minutes and try again.",
    code: "RATE_LIMITED",
  },
});
