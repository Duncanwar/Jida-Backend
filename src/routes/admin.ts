import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { authMiddleware, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { hashPassword } from "../utils/password.js";
import { normalizeRoles } from "../utils/roles.js";

export const adminRouter = Router();
adminRouter.use(authMiddleware, requireRole(Role.ADMIN));

const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  roles: true,
  firstName: true,
  lastName: true,
  affiliation: true,
  createdAt: true,
} as const;

function toAdminUser(u: {
  id: string;
  email: string;
  role: Role;
  roles: Role[];
  firstName: string | null;
  lastName: string | null;
  affiliation: string | null;
  createdAt: Date;
}) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    roles: normalizeRoles(u.role, u.roles),
    name: name || undefined,
    institution: u.affiliation ?? undefined,
    createdAt: u.createdAt.toISOString(),
  };
}

adminRouter.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: USER_SELECT,
    });
    res.json(users.map(toAdminUser));
  }),
);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  /** Primary role — decides which portal the account lands on. */
  role: z.nativeEnum(Role),
  /**
   * Every role to grant. Admins are the only ones who can hand out the editor
   * tiers, which is why this accepts the full enum where signup does not.
   */
  roles: z.array(z.nativeEnum(Role)).optional(),
  name: z.string().optional(),
  institution: z.string().optional(),
});

adminRouter.post(
  "/users",
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    const [firstName, ...rest] = (body.name ?? "").trim().split(/\s+/).filter(Boolean);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        roles: normalizeRoles(body.role, body.roles),
        firstName: firstName || undefined,
        lastName: rest.length ? rest.join(" ") : undefined,
        affiliation: body.institution,
        // FR-AUTH-1 — accounts provisioned by an admin are created verified.
        // The admin vouches for the address and hands over the password
        // out-of-band; no verification email is sent, so leaving these
        // unverified would create accounts that can never sign in.
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
      select: USER_SELECT,
    });
    res.status(201).json(toAdminUser(user));
  }),
);

const updateRolesSchema = z.object({
  role: z.nativeEnum(Role),
  roles: z.array(z.nativeEnum(Role)).optional(),
});

/**
 * Changes which roles an existing account holds — how a sitting editor becomes
 * a chief editor, or an author is also made a reviewer. Without this, roles
 * could only ever be chosen when the account was first created.
 */
adminRouter.patch(
  "/users/:id/roles",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = updateRolesSchema.parse(req.body);
    const roles = normalizeRoles(body.role, body.roles);

    // An admin removing their own ADMIN role would lock the console away from
    // the only account that can hand it back.
    if (req.params.id === req.user!.id && !roles.includes(Role.ADMIN)) {
      res.status(400).json({ error: "You cannot remove your own admin role" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role: body.role, roles },
      select: USER_SELECT,
    });
    res.json(toAdminUser(user));
  }),
);

adminRouter.delete(
  "/users/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.params.id === req.user!.id) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ message: "User deleted" });
  }),
);
