import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../utils/jwt.js";
import { Role } from "@prisma/client";
import { hasAnyRole } from "../utils/roles.js";

export type AuthedRequest = Request & {
  user?: { id: string; role: Role; roles: Role[]; emailVerified: boolean };
};

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const token = header.slice("Bearer ".length).trim();

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role as Role,
      // Tokens minted before multi-role support carry no `roles` claim; fall
      // back to the single role so in-flight sessions keep working.
      roles: (payload.roles?.length ? payload.roles : [payload.role]) as Role[],
      // Tokens minted before the `ev` claim existed are treated as verified so
      // an in-flight session is not invalidated by a deploy.
      emailVerified: payload.ev !== false,
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // Checks the account's whole role set, expanded through the implication
    // rules — a chief editor reaches the reviewer and author routes too.
    if (!hasAnyRole(req.user.roles, roles)) {
      res.status(403).json({ error: "Forbidden for this role" });
      return;
    }
    next();
  };
}

/**
 * FR-AUTH-1 — defence in depth for the verification gate.
 *
 * Login already refuses unverified accounts, so in practice no unverified token
 * should ever reach a protected route. This middleware makes that guarantee
 * explicit at the point of use, and reads the JWT claim rather than the
 * database so it costs nothing per request.
 */
export function requireVerifiedEmail(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!req.user.emailVerified && !req.user.roles.includes(Role.ADMIN)) {
    res.status(403).json({
      error: "Verify your email address to continue.",
      code: "EMAIL_NOT_VERIFIED",
    });
    return;
  }
  next();
}
