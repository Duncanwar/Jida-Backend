/**
 * FR-AUTH-1 — email address verification.
 *
 * Every account except the system admin must prove it controls the email
 * address it registered with before it can sign in. Google accounts are exempt
 * because Google has already performed that check (we only accept ID tokens
 * whose `email_verified` claim is true).
 *
 * Design notes:
 *  - Only the SHA-256 hash of a token is persisted, so a database dump cannot
 *    be replayed to activate accounts.
 *  - Tokens are single-use (`consumedAt`) and expiring.
 *  - Issuing a new token invalidates outstanding ones for that user.
 *  - Resends are throttled per-user by cooldown and by absolute count.
 */
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { hashToken, randomToken } from "../utils/cryptoToken.js";
import { sendMail } from "./email.js";
import { verificationEmail, welcomeEmail } from "./emailTemplates.js";
import type { Role, User } from "@prisma/client";

export class VerificationRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Please wait before requesting another verification email.");
    this.name = "VerificationRateLimitError";
  }
}

export class VerificationSendLimitError extends Error {
  constructor() {
    super("Too many verification emails requested. Contact support for help.");
    this.name = "VerificationSendLimitError";
  }
}

function ttlMs(): number {
  return env.EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000;
}

function displayName(user: Pick<User, "firstName" | "lastName">): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

/** Builds the link the user clicks. Points at the frontend, not the API. */
export function buildVerifyUrl(rawToken: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Issues a fresh verification token and emails it.
 *
 * @param enforceThrottle when true (resend path) the cooldown and per-address
 *        send cap are applied. False on initial registration.
 */
export async function issueVerificationEmail(
  user: Pick<User, "id" | "email" | "firstName" | "lastName">,
  options: { enforceThrottle?: boolean } = {},
): Promise<void> {
  if (options.enforceThrottle) {
    const recent = await prisma.emailVerificationToken.findFirst({
      where: { userId: user.id },
      orderBy: { lastSentAt: "desc" },
    });

    if (recent) {
      const elapsedSec = (Date.now() - recent.lastSentAt.getTime()) / 1000;
      const cooldown = env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC;
      if (elapsedSec < cooldown) {
        throw new VerificationRateLimitError(Math.ceil(cooldown - elapsedSec));
      }
      if (recent.sentCount >= env.EMAIL_VERIFICATION_MAX_SENDS) {
        throw new VerificationSendLimitError();
      }
    }
  }

  // Carry the send count forward so the cap survives token rotation.
  const previous = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id },
    orderBy: { lastSentAt: "desc" },
    select: { sentCount: true },
  });

  const raw = randomToken();
  await prisma.$transaction([
    // Supersede any outstanding token — only the newest link should work.
    prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
    prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + ttlMs()),
        sentCount: (previous?.sentCount ?? 0) + 1,
        lastSentAt: new Date(),
      },
    }),
  ]);

  const mail = verificationEmail({
    name: displayName(user),
    verifyUrl: buildVerifyUrl(raw),
    ttlHours: env.EMAIL_VERIFICATION_TTL_HOURS,
  });

  // Registration is not considered successful unless the email is on its way,
  // so failures here propagate to the caller.
  await sendMail({ to: user.email, ...mail });
}

export type ConsumeResult =
  | { ok: true; alreadyVerified: boolean; user: { id: string; email: string; role: Role } }
  | { ok: false; reason: "invalid" | "expired" };

/** Validates a raw token and flips the account to verified. Single-use. */
export async function consumeVerificationToken(rawToken: string): Promise<ConsumeResult> {
  const tokenHash = hashToken(rawToken);
  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, role: true, emailVerified: true, firstName: true, lastName: true } } },
  });

  if (!record) return { ok: false, reason: "invalid" };

  // Clicking the same link twice (mail scanners pre-fetch links routinely)
  // should read as success, not as an error, provided the account is verified.
  if (record.consumedAt) {
    return record.user.emailVerified
      ? { ok: true, alreadyVerified: true, user: record.user }
      : { ok: false, reason: "invalid" };
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    }),
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
  ]);

  // Welcome mail is a courtesy — never fail verification because it bounced.
  const mail = welcomeEmail({
    name: displayName(record.user),
    loginUrl: `${env.APP_URL.replace(/\/$/, "")}/login`,
    role: record.user.role,
  });
  void sendMail({ to: record.user.email, ...mail }).catch((err: unknown) => {
    console.error("[email] welcome mail failed:", err instanceof Error ? err.message : err);
  });

  return { ok: true, alreadyVerified: false, user: record.user };
}

/** Housekeeping: drop expired, unconsumed tokens. Called by the scheduler. */
export async function purgeExpiredVerificationTokens(): Promise<number> {
  const { count } = await prisma.emailVerificationToken.deleteMany({
    where: { expiresAt: { lt: new Date() }, consumedAt: null },
  });
  return count;
}
