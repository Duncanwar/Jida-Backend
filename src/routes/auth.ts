import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { signAccessToken } from "../utils/jwt.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { hashToken, randomToken } from "../utils/cryptoToken.js";
import { sendMail } from "../services/email.js";
import { passwordResetEmail } from "../services/emailTemplates.js";
import {
  consumeVerificationToken,
  issueVerificationEmail,
  VerificationRateLimitError,
  VerificationSendLimitError,
} from "../services/emailVerification.js";
import { GoogleAuthError, verifyGoogleIdToken } from "../services/googleAuth.js";
import { authRateLimiter, verificationRateLimiter } from "../middleware/rateLimit.js";
import { AuthProvider, Role, type User } from "@prisma/client";
import { expandRoles, normalizeRoles } from "../utils/roles.js";
import { env, googleAuthEnabled } from "../config/env.js";

export const authRouter = Router();

/** Shape returned to the client for an authenticated user. */
function publicUser(
  user: Pick<
    User,
    "id" | "email" | "role" | "firstName" | "lastName" | "emailVerified" | "avatarUrl"
  > & { roles?: Role[] },
) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    // Expanded so the client can render a switcher for every portal the
    // account can actually reach, not just the roles literally stored.
    roles: expandRoles(normalizeRoles(user.role, user.roles)),
    firstName: user.firstName,
    lastName: user.lastName,
    emailVerified: user.emailVerified,
    avatarUrl: user.avatarUrl,
  };
}

function splitName(name?: string): { firstName?: string; lastName?: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  const [firstName, ...rest] = parts;
  return { firstName, lastName: rest.length ? rest.join(" ") : undefined };
}

// ─── Registration ────────────────────────────────────────────────────────────

const registerSchema = z
  .object({
    email: z.string().email().transform((v) => v.toLowerCase().trim()),
    password: z.string().min(8, "Password must be at least 8 characters"),
    // RM-03 — admins cannot self-register; they are provisioned via the seed
    // script. Editor tiers are assigned by an admin, not chosen at signup.
    role: z.enum([Role.AUTHOR, Role.REVIEWER, Role.EDITOR]),
    /** Additional roles requested at signup, e.g. an author who also reviews. */
    roles: z.array(z.enum([Role.AUTHOR, Role.REVIEWER, Role.EDITOR])).optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    // The frontend sends a single `name` field; accept both spellings.
    name: z.string().optional(),
    affiliation: z.string().optional(),
    institution: z.string().optional(),
  })
  .transform((body) => {
    const fromName = splitName(body.name);
    return {
      ...body,
      firstName: body.firstName ?? fromName.firstName,
      lastName: body.lastName ?? fromName.lastName,
      affiliation: body.affiliation ?? body.institution,
    };
  });

authRouter.post(
  "/register",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      // An unverified local account can be re-claimed by resending the link
      // rather than being a permanent dead end after a mistyped signup.
      if (!existing.emailVerified && existing.authProvider === AuthProvider.LOCAL) {
        res.status(409).json({
          error: "This email is already registered but not yet verified.",
          code: "EMAIL_UNVERIFIED",
          email: existing.email,
        });
        return;
      }
      res.status(409).json({ error: "Email already registered", code: "EMAIL_TAKEN" });
      return;
    }

    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role: body.role,
        roles: normalizeRoles(body.role, body.roles),
        firstName: body.firstName,
        lastName: body.lastName,
        affiliation: body.affiliation,
        authProvider: AuthProvider.LOCAL,
        emailVerified: false,
      },
    });

    // Requirement 1: no access token is issued until the address is verified.
    try {
      await issueVerificationEmail(user);
    } catch (err) {
      // If the address cannot receive mail the account can never be activated,
      // so roll it back and let the user correct the typo and register again.
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      console.error("[auth] verification email failed at registration:", err);
      res.status(502).json({
        error: "We could not send the verification email. Check the address and try again.",
        code: "VERIFICATION_EMAIL_FAILED",
      });
      return;
    }

    res.status(201).json({
      user: publicUser(user),
      requiresEmailVerification: true,
      message: `Account created. We sent a verification link to ${user.email} — confirm it to activate your account.`,
    });
  }),
);

// ─── Login ───────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    // Google-only accounts have no password hash. Say so explicitly — the user
    // has a working way in and a generic 401 would just strand them.
    if (!user.passwordHash) {
      res.status(401).json({
        error: 'This account was created with Google. Use "Continue with Google" to sign in.',
        code: "USE_GOOGLE_SIGNIN",
      });
      return;
    }

    if (!(await verifyPassword(body.password, user.passwordHash))) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    // Requirement 1 — the verification gate. The admin is exempt: it is seeded
    // pre-verified and must never be able to lock itself out of the system.
    const heldRoles = normalizeRoles(user.role, user.roles);
    if (!user.emailVerified && !heldRoles.includes(Role.ADMIN)) {
      res.status(403).json({
        error: "Please verify your email address before signing in. Check your inbox for the link.",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
      return;
    }

    const token = signAccessToken(user.id, user.role, user.emailVerified, expandRoles(heldRoles));
    res.json({
      user: publicUser(user),
      accessToken: token,
      expiresInMinutes: env.JWT_ACCESS_EXPIRES_MIN,
      message: "Successful Login",
    });
  }),
);

// ─── Email verification (FR-AUTH-1) ──────────────────────────────────────────

const verifySchema = z.object({ token: z.string().min(1) });

async function handleVerify(rawToken: string, res: Response): Promise<void> {
  const result = await consumeVerificationToken(rawToken);

  if (!result.ok) {
    res.status(400).json({
      error:
        result.reason === "expired"
          ? "This verification link has expired. Request a new one."
          : "This verification link is invalid or has already been used.",
      code: result.reason === "expired" ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
    });
    return;
  }

  // Verification proves control of the mailbox, so it is safe to sign the user
  // straight in — it removes a pointless second credential prompt.
  const verifiedRoles = expandRoles(normalizeRoles(result.user.role, result.user.roles));
  const accessToken = signAccessToken(result.user.id, result.user.role, true, verifiedRoles);
  res.json({
    message: result.alreadyVerified
      ? "This email address is already verified."
      : "Email verified. Your account is now active.",
    alreadyVerified: result.alreadyVerified,
    user: {
      id: result.user.id,
      email: result.user.email,
      role: result.user.role,
      roles: verifiedRoles,
      emailVerified: true,
    },
    accessToken,
    expiresInMinutes: env.JWT_ACCESS_EXPIRES_MIN,
  });
}

authRouter.post(
  "/verify-email",
  verificationRateLimiter,
  asyncHandler(async (req, res) => {
    const { token } = verifySchema.parse(req.body);
    await handleVerify(token, res);
  }),
);

// GET variant so a verification link still works if the frontend is unavailable.
authRouter.get(
  "/verify-email",
  verificationRateLimiter,
  asyncHandler(async (req, res) => {
    const { token } = verifySchema.parse(req.query);
    await handleVerify(token, res);
  }),
);

const resendSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
});

authRouter.post(
  "/resend-verification",
  verificationRateLimiter,
  asyncHandler(async (req, res) => {
    const { email } = resendSchema.parse(req.body);
    // Constant response regardless of account existence — this endpoint must
    // not become an oracle for which addresses are registered.
    const genericMessage = "If that address needs verification, we have sent a new link to it.";

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerified) {
      res.json({ message: genericMessage });
      return;
    }

    try {
      await issueVerificationEmail(user, { enforceThrottle: true });
    } catch (err) {
      if (err instanceof VerificationRateLimitError) {
        res
          .status(429)
          .set("Retry-After", String(err.retryAfterSeconds))
          .json({
            error: err.message,
            code: "RESEND_COOLDOWN",
            retryAfterSeconds: err.retryAfterSeconds,
          });
        return;
      }
      if (err instanceof VerificationSendLimitError) {
        res.status(429).json({ error: err.message, code: "RESEND_LIMIT" });
        return;
      }
      throw err;
    }

    res.json({ message: genericMessage });
  }),
);

/** Lets the frontend render a "verify your email" state without guessing. */
authRouter.get(
  "/verification-status",
  asyncHandler(async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.toLowerCase().trim() : "";
    if (!email) {
      res.status(400).json({ error: "email query parameter is required" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { email },
      select: { emailVerified: true },
    });
    // Unknown addresses report "verified" so this cannot enumerate accounts.
    res.json({ emailVerified: user?.emailVerified ?? true });
  }),
);

// ─── Google sign-in (FR-AUTH-2) ──────────────────────────────────────────────

const googleSchema = z.object({
  // Google Identity Services calls this `credential`; accept `idToken` too.
  credential: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  /** Role requested on first sign-up. Ignored for accounts that already exist. */
  role: z.enum([Role.AUTHOR, Role.REVIEWER, Role.EDITOR]).optional(),
  affiliation: z.string().optional(),
  institution: z.string().optional(),
});

authRouter.get("/google/config", (_req, res) => {
  // Lets the frontend hide the Google button when no client ID is configured.
  res.json({ enabled: googleAuthEnabled, clientId: env.GOOGLE_CLIENT_ID ?? null });
});

authRouter.post(
  "/google",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    if (!googleAuthEnabled) {
      res.status(501).json({
        error: "Google sign-in is not configured for this deployment.",
        code: "GOOGLE_DISABLED",
      });
      return;
    }

    const body = googleSchema.parse(req.body);
    const rawToken = body.credential ?? body.idToken;
    if (!rawToken) {
      res.status(400).json({ error: "A Google credential is required" });
      return;
    }

    let identity;
    try {
      identity = await verifyGoogleIdToken(rawToken);
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        res.status(401).json({ error: err.message, code: "GOOGLE_TOKEN_INVALID" });
        return;
      }
      throw err;
    }

    // Match on the Google subject first (it is stable across email changes),
    // then fall back to email so an existing password account is linked rather
    // than duplicated.
    let user = await prisma.user.findUnique({ where: { googleId: identity.googleId } });
    let created = false;

    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });

      if (byEmail) {
        // Linking also clears a pending verification on a local account: the
        // user just proved mailbox control through Google.
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: {
            googleId: identity.googleId,
            avatarUrl: byEmail.avatarUrl ?? identity.avatarUrl,
            firstName: byEmail.firstName ?? identity.firstName,
            lastName: byEmail.lastName ?? identity.lastName,
            emailVerified: true,
            emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
            authProvider: byEmail.passwordHash ? AuthProvider.BOTH : AuthProvider.GOOGLE,
          },
        });
      } else {
        user = await prisma.user.create({
          data: {
            email: identity.email,
            passwordHash: null,
            role: body.role ?? Role.AUTHOR,
            roles: normalizeRoles(body.role ?? Role.AUTHOR),
            firstName: identity.firstName,
            lastName: identity.lastName,
            affiliation: body.affiliation ?? body.institution,
            googleId: identity.googleId,
            avatarUrl: identity.avatarUrl,
            authProvider: AuthProvider.GOOGLE,
            // Google already verified the address — no second round trip.
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
        created = true;
      }
    }

    const accessToken = signAccessToken(
      user.id,
      user.role,
      true,
      expandRoles(normalizeRoles(user.role, user.roles)),
    );
    res.status(created ? 201 : 200).json({
      user: publicUser(user),
      accessToken,
      expiresInMinutes: env.JWT_ACCESS_EXPIRES_MIN,
      created,
      message: created ? "Account created with Google" : "Successful Login",
    });
  }),
);

// ─── Password reset (FR-AUTH-3) ──────────────────────────────────────────────

const forgotSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
});

const RESET_TTL_MINUTES = 60;

authRouter.post(
  "/forgot-password",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);
    const genericMessage = "If an account exists, reset instructions were sent.";

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.json({ message: genericMessage });
      return;
    }

    // A Google-only account has no password to reset.
    if (!user.passwordHash) {
      res.json({ message: genericMessage });
      return;
    }

    const raw = randomToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(raw), expiresAt },
    });

    const resetUrl = `${env.APP_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(raw)}`;
    const mail = passwordResetEmail({
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
      resetUrl,
      token: raw,
      ttlMinutes: RESET_TTL_MINUTES,
    });
    await sendMail({ to: user.email, ...mail });

    res.json({ message: genericMessage });
  }),
);

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

authRouter.post(
  "/reset-password",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const body = resetSchema.parse(req.body);
    const tokenHash = hashToken(body.token);
    const record = await prisma.passwordResetToken.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
    });
    if (!record) {
      res.status(400).json({ error: "Invalid or expired token" });
      return;
    }
    const passwordHash = await hashPassword(body.newPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          // Receiving the reset mail proves mailbox control, so treat it as
          // verification too — otherwise the user is stuck in a loop.
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      }),
      prisma.passwordResetToken.deleteMany({ where: { userId: record.userId } }),
    ]);
    res.json({ message: "Password updated" });
  }),
);
