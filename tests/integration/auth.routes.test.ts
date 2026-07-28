import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "../helpers/prismaMock.js";
import { hashPassword } from "../../src/utils/password.js";
import { hashToken } from "../../src/utils/cryptoToken.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../src/services/email.js", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendMailSafe: vi.fn().mockResolvedValue(true),
  verifyEmailTransport: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/googleAuth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/googleAuth.js")>(
    "../../src/services/googleAuth.js",
  );
  return { ...actual, verifyGoogleIdToken: vi.fn() };
});

const { createApp } = await import("../../src/app.js");
const { sendMail } = await import("../../src/services/email.js");
const { verifyGoogleIdToken, GoogleAuthError } = await import("../../src/services/googleAuth.js");
const app = createApp();

beforeEach(() => {
  resetPrismaMock();
  vi.mocked(sendMail).mockClear().mockResolvedValue(undefined);
  vi.mocked(verifyGoogleIdToken).mockReset();
});

describe("POST /api/auth/register", () => {
  const body = {
    email: "author@example.com",
    password: "password123",
    role: "AUTHOR",
    firstName: "Ada",
    lastName: "Lovelace",
  };

  const createdUser = {
    id: "u1",
    email: body.email,
    role: "AUTHOR",
    firstName: "Ada",
    lastName: "Lovelace",
    emailVerified: false,
    avatarUrl: null,
  };

  it("creates the account, hashes the password, and sends a verification email", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(createdUser);
    prismaMock.emailVerificationToken.findFirst.mockResolvedValue(null);
    prismaMock.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.emailVerificationToken.create.mockResolvedValue({});

    const res = await request(app).post("/api/auth/register").send(body);

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(body.email);
    expect(prismaMock.user.create).toHaveBeenCalledOnce();

    const createArg = prismaMock.user.create.mock.calls[0][0];
    expect(createArg.data.passwordHash).not.toBe(body.password);
    expect(createArg.data.emailVerified).toBe(false);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  // Requirement 1: no session until the address is confirmed.
  it("does NOT return an access token before verification", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(createdUser);
    prismaMock.emailVerificationToken.findFirst.mockResolvedValue(null);
    prismaMock.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.emailVerificationToken.create.mockResolvedValue({});

    const res = await request(app).post("/api/auth/register").send(body);

    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.requiresEmailVerification).toBe(true);
  });

  it("stores only the sha256 hash of the verification token", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(createdUser);
    prismaMock.emailVerificationToken.findFirst.mockResolvedValue(null);
    prismaMock.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.emailVerificationToken.create.mockResolvedValue({});

    await request(app).post("/api/auth/register").send(body);

    const stored = prismaMock.emailVerificationToken.create.mock.calls[0][0].data.tokenHash;
    const emailedBody = vi.mocked(sendMail).mock.calls[0][0].text;
    const rawToken = /token=([a-f0-9]+)/.exec(emailedBody)?.[1];

    expect(rawToken).toBeTruthy();
    expect(stored).toBe(hashToken(rawToken!));
    expect(stored).not.toBe(rawToken);
  });

  it("rolls the account back if the verification email cannot be sent", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(createdUser);
    prismaMock.emailVerificationToken.findFirst.mockResolvedValue(null);
    prismaMock.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.emailVerificationToken.create.mockResolvedValue({});
    prismaMock.user.delete.mockResolvedValue(createdUser);
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("smtp down"));

    const res = await request(app).post("/api/auth/register").send(body);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("VERIFICATION_EMAIL_FAILED");
    expect(prismaMock.user.delete).toHaveBeenCalledOnce();
  });

  it("returns 409 for a duplicate verified email", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "existing",
      emailVerified: true,
      authProvider: "LOCAL",
    });
    const res = await request(app).post("/api/auth/register").send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_TAKEN");
  });

  it("flags a duplicate UNVERIFIED email so the UI can offer a resend", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "existing",
      email: body.email,
      emailVerified: false,
      authProvider: "LOCAL",
    });
    const res = await request(app).post("/api/auth/register").send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_UNVERIFIED");
  });

  it("returns 400 for an invalid payload", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "not-an-email", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("does not allow registering as ADMIN", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...body, role: "ADMIN" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("logs in a verified user", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      role: "AUTHOR",
      firstName: "Ada",
      lastName: "Lovelace",
      emailVerified: true,
      avatarUrl: null,
      passwordHash: await hashPassword("password123"),
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "author@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.id).toBe("u1");
  });

  // Requirement 1: the gate itself.
  it("blocks an unverified user with 403 even when the password is correct", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      role: "AUTHOR",
      emailVerified: false,
      avatarUrl: null,
      passwordHash: await hashPassword("password123"),
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "author@example.com", password: "password123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(res.body.accessToken).toBeUndefined();
  });

  it("exempts the admin from the verification gate", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "admin1",
      email: "admin@example.com",
      role: "ADMIN",
      emailVerified: false,
      avatarUrl: null,
      passwordHash: await hashPassword("password123"),
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("tells a Google-only account to use Google instead of failing generically", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u2",
      email: "google@example.com",
      role: "AUTHOR",
      emailVerified: true,
      avatarUrl: null,
      passwordHash: null,
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "google@example.com", password: "anything1" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("USE_GOOGLE_SIGNIN");
  });

  it("rejects a wrong password with 401", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      role: "AUTHOR",
      emailVerified: true,
      passwordHash: await hashPassword("password123"),
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "author@example.com", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("rejects an unknown email with 401", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@example.com", password: "whatever1" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/verify-email", () => {
  const tokenRecord = (overrides: Record<string, unknown> = {}) => ({
    id: "tok1",
    userId: "u1",
    tokenHash: hashToken("raw-verify-token"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    consumedAt: null,
    user: {
      id: "u1",
      email: "author@example.com",
      role: "AUTHOR",
      emailVerified: false,
      firstName: "Ada",
      lastName: "Lovelace",
    },
    ...overrides,
  });

  it("verifies the account and returns a usable session", async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(tokenRecord());

    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: "raw-verify-token" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.emailVerified).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ emailVerified: true }) }),
    );
  });

  it("looks the token up by hash, never by the raw value", async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(null);
    await request(app).post("/api/auth/verify-email").send({ token: "raw-verify-token" });

    const arg = prismaMock.emailVerificationToken.findUnique.mock.calls[0][0];
    expect(arg.where.tokenHash).toBe(hashToken("raw-verify-token"));
  });

  it("rejects an expired token with a distinguishable code", async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(
      tokenRecord({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: "raw-verify-token" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects an unknown token", async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(null);
    const res = await request(app).post("/api/auth/verify-email").send({ token: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });

  // Mail scanners pre-fetch links, so a second click must not read as an error.
  it("treats a re-click of an already-consumed link as success", async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(
      tokenRecord({
        consumedAt: new Date(),
        user: {
          id: "u1",
          email: "author@example.com",
          role: "AUTHOR",
          emailVerified: true,
          firstName: "Ada",
          lastName: "Lovelace",
        },
      }),
    );

    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: "raw-verify-token" });

    expect(res.status).toBe(200);
    expect(res.body.alreadyVerified).toBe(true);
  });
});

describe("POST /api/auth/resend-verification", () => {
  it("sends a new link for an unverified account", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      emailVerified: false,
      firstName: "Ada",
      lastName: "Lovelace",
    });
    prismaMock.emailVerificationToken.findFirst.mockResolvedValue(null);
    prismaMock.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.emailVerificationToken.create.mockResolvedValue({});

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "author@example.com" });

    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it("throttles a resend inside the cooldown window", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      emailVerified: false,
    });
    prismaMock.emailVerificationToken.findFirst.mockResolvedValue({
      id: "tok1",
      sentCount: 1,
      lastSentAt: new Date(), // just now
    });

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "author@example.com" });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RESEND_COOLDOWN");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("caps the total number of resends", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      emailVerified: false,
    });
    prismaMock.emailVerificationToken.findFirst.mockResolvedValue({
      id: "tok1",
      sentCount: 5,
      lastSentAt: new Date(Date.now() - 10 * 60 * 1000), // past the cooldown
    });

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "author@example.com" });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RESEND_LIMIT");
  });

  it("gives the same answer for unknown addresses (no enumeration)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "ghost@example.com" });

    expect(res.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/google", () => {
  const identity = {
    googleId: "google-sub-123",
    email: "google@example.com",
    emailVerified: true,
    firstName: "Grace",
    lastName: "Hopper",
    avatarUrl: "https://example.com/a.png",
  };

  it("creates a pre-verified account on first sign-in", async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue(identity);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: "g1",
      email: identity.email,
      role: "AUTHOR",
      firstName: "Grace",
      lastName: "Hopper",
      emailVerified: true,
      avatarUrl: identity.avatarUrl,
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ credential: "google-id-token", role: "AUTHOR" });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.created).toBe(true);

    const createArg = prismaMock.user.create.mock.calls[0][0];
    // Google has already verified the address — no second round trip.
    expect(createArg.data.emailVerified).toBe(true);
    expect(createArg.data.googleId).toBe(identity.googleId);
    expect(createArg.data.passwordHash).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("honours the role chosen at sign-up", async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue(identity);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: "g1",
      email: identity.email,
      role: "REVIEWER",
      emailVerified: true,
      avatarUrl: null,
    });

    await request(app).post("/api/auth/google").send({ credential: "tok", role: "REVIEWER" });

    expect(prismaMock.user.create.mock.calls[0][0].data.role).toBe("REVIEWER");
  });

  it("links Google to an existing password account instead of duplicating it", async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue(identity);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null) // by googleId
      .mockResolvedValueOnce({
        id: "existing",
        email: identity.email,
        role: "AUTHOR",
        passwordHash: "hashed",
        emailVerified: false,
        emailVerifiedAt: null,
        avatarUrl: null,
        firstName: null,
        lastName: null,
      });
    prismaMock.user.update.mockResolvedValue({
      id: "existing",
      email: identity.email,
      role: "AUTHOR",
      emailVerified: true,
      avatarUrl: identity.avatarUrl,
    });

    const res = await request(app).post("/api/auth/google").send({ credential: "tok" });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(prismaMock.user.create).not.toHaveBeenCalled();

    const updateArg = prismaMock.user.update.mock.calls[0][0];
    expect(updateArg.data.googleId).toBe(identity.googleId);
    // Signing in through Google proves mailbox control, clearing the gate.
    expect(updateArg.data.emailVerified).toBe(true);
    expect(updateArg.data.authProvider).toBe("BOTH");
  });

  it("signs an existing Google account straight in", async () => {
    vi.mocked(verifyGoogleIdToken).mockResolvedValue(identity);
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "g1",
      email: identity.email,
      role: "EDITOR",
      emailVerified: true,
      avatarUrl: null,
    });

    const res = await request(app).post("/api/auth/google").send({ credential: "tok" });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("EDITOR");
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable Google token with 401", async () => {
    vi.mocked(verifyGoogleIdToken).mockRejectedValue(new GoogleAuthError("bad signature"));

    const res = await request(app).post("/api/auth/google").send({ credential: "forged" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("GOOGLE_TOKEN_INVALID");
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("requires a credential", async () => {
    const res = await request(app).post("/api/auth/google").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/forgot-password", () => {
  it("creates a reset token and sends an email for a known user", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      passwordHash: "hashed",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    prismaMock.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.passwordResetToken.create.mockResolvedValue({});

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "author@example.com" });

    expect(res.status).toBe(200);
    expect(prismaMock.passwordResetToken.create).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it("returns the same message for an unknown user (no enumeration)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "ghost@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("does not email a Google-only account (there is no password to reset)", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "g1",
      email: "google@example.com",
      passwordHash: null,
      authProvider: "GOOGLE",
    });
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "google@example.com" });
    expect(res.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/reset-password", () => {
  it("rejects an invalid or expired token", async () => {
    prismaMock.passwordResetToken.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "bad-token", newPassword: "newpassword1" });
    expect(res.status).toBe(400);
  });

  it("looks up the token by its sha256 hash, not the raw value", async () => {
    prismaMock.passwordResetToken.findFirst.mockResolvedValue(null);
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "raw-token", newPassword: "newpassword1" });
    const arg = prismaMock.passwordResetToken.findFirst.mock.calls[0][0];
    expect(arg.where.tokenHash).toBe(hashToken("raw-token"));
  });

  it("marks the address verified — receiving the reset mail proves control", async () => {
    prismaMock.passwordResetToken.findFirst.mockResolvedValue({ id: "r1", userId: "u1" });
    prismaMock.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.user.update.mockResolvedValue({});

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "raw-token", newPassword: "newpassword1" });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ emailVerified: true }) }),
    );
  });
});

describe("GET /api/auth/verification-status", () => {
  it("reports the status of a known address", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ emailVerified: false });
    const res = await request(app)
      .get("/api/auth/verification-status")
      .query({ email: "author@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(false);
  });

  it("reports unknown addresses as verified so it cannot enumerate accounts", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/auth/verification-status")
      .query({ email: "ghost@example.com" });
    expect(res.body.emailVerified).toBe(true);
  });
});
