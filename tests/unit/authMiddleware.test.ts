import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { Role } from "@prisma/client";
import { authMiddleware, requireRole, type AuthedRequest } from "../../src/middleware/auth.js";
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
    expect(req.user).toEqual({ id: "user-42", role: Role.EDITOR });
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
