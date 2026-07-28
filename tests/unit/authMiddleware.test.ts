import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { Role } from "@prisma/client";
import {
  authMiddleware,
  requireRole,
  requireVerifiedEmail,
  type AuthedRequest,
} from "../../src/middleware/auth.js";
import { signAccessToken } from "../../src/utils/jwt.js";

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe("authMiddleware", () => {
  it("rejects requests without a bearer token", () => {
    const res = mockRes();
    const next = vi.fn();
    authMiddleware({ headers: {} } as AuthedRequest, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an invalid token", () => {
    const res = mockRes();
    const next = vi.fn();
    authMiddleware({ headers: { authorization: "Bearer not-a-jwt" } } as AuthedRequest, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a valid token and attaches the user", () => {
    const token = signAccessToken("user-42", Role.EDITOR);
    const req = { headers: { authorization: `Bearer ${token}` } } as AuthedRequest;
    const next = vi.fn();
    authMiddleware(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: "user-42", role: Role.EDITOR, emailVerified: true });
  });

  it("carries the email-verified claim through from the token", () => {
    const token = signAccessToken("user-43", Role.AUTHOR, false);
    const req = { headers: { authorization: `Bearer ${token}` } } as AuthedRequest;
    authMiddleware(req, mockRes(), vi.fn());
    expect(req.user?.emailVerified).toBe(false);
  });
});

describe("requireVerifiedEmail", () => {
  it("returns 401 when no user is attached", () => {
    const res = mockRes();
    const next = vi.fn();
    requireVerifiedEmail({ headers: {} } as AuthedRequest, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks an unverified user with 403", () => {
    const res = mockRes();
    const next = vi.fn();
    const req = {
      user: { id: "u", role: Role.AUTHOR, emailVerified: false },
    } as AuthedRequest;
    requireVerifiedEmail(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EMAIL_NOT_VERIFIED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a verified user through", () => {
    const next = vi.fn();
    const req = { user: { id: "u", role: Role.AUTHOR, emailVerified: true } } as AuthedRequest;
    requireVerifiedEmail(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("exempts the admin so it can never lock itself out", () => {
    const next = vi.fn();
    const req = { user: { id: "a", role: Role.ADMIN, emailVerified: false } } as AuthedRequest;
    requireVerifiedEmail(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireRole", () => {
  it("returns 401 when no user is attached", () => {
    const res = mockRes();
    const next = vi.fn();
    requireRole(Role.ADMIN)({ headers: {} } as AuthedRequest, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for a disallowed role", () => {
    const res = mockRes();
    const next = vi.fn();
    const req = { user: { id: "u", role: Role.AUTHOR } } as AuthedRequest;
    requireRole(Role.ADMIN, Role.EDITOR)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes through an allowed role", () => {
    const next = vi.fn();
    const req = { user: { id: "u", role: Role.EDITOR } } as AuthedRequest;
    requireRole(Role.ADMIN, Role.EDITOR)(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
