import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "../helpers/prismaMock.js";
import { hashPassword } from "../../src/utils/password.js";
import { hashToken } from "../../src/utils/cryptoToken.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../src/services/email.js", () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));

const { createApp } = await import("../../src/app.js");
const { sendMail } = await import("../../src/services/email.js");
const app = createApp();

beforeEach(() => {
  resetPrismaMock();
  vi.mocked(sendMail).mockClear();
});

describe("POST /api/auth/register", () => {
  const body = {
    email: "author@example.com",
    password: "password123",
    role: "AUTHOR",
    firstName: "Ada",
    lastName: "Lovelace",
  };

  it("registers a new user and returns a token", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: "u1",
      email: body.email,
      role: "AUTHOR",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    const res = await request(app).post("/api/auth/register").send(body);

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(body.email);
    expect(res.body.accessToken).toBeTruthy();
    expect(prismaMock.user.create).toHaveBeenCalledOnce();
    // password must be hashed, never stored raw
    const createArg = prismaMock.user.create.mock.calls[0][0];
    expect(createArg.data.passwordHash).not.toBe(body.password);
  });

  it("returns 409 for a duplicate email", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "existing" });
    const res = await request(app).post("/api/auth/register").send(body);
    expect(res.status).toBe(409);
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
  it("logs in with valid credentials", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      role: "AUTHOR",
      firstName: "Ada",
      lastName: "Lovelace",
      passwordHash: await hashPassword("password123"),
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "author@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.id).toBe("u1");
  });

  it("rejects a wrong password with 401", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "author@example.com",
      role: "AUTHOR",
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

describe("POST /api/auth/forgot-password", () => {
  it("creates a reset token and sends an email for a known user", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "u1", email: "author@example.com" });
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
});
