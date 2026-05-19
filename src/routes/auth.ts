import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { signAccessToken } from "../utils/jwt.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { hashToken, randomToken } from "../utils/cryptoToken.js";
import { sendMail } from "../services/email.js";
import { Role } from "@prisma/client";
import { env } from "../config/env.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.nativeEnum(Role),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  affiliation: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        role: body.role,
        firstName: body.firstName,
        lastName: body.lastName,
        affiliation: body.affiliation,
      },
      select: { id: true, email: true, role: true, firstName: true, lastName: true },
    });
    const token = signAccessToken(user.id, user.role);
    res.status(201).json({ user, accessToken: token, expiresInMinutes: env.JWT_ACCESS_EXPIRES_MIN });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = signAccessToken(user.id, user.role);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      accessToken: token,
      expiresInMinutes: env.JWT_ACCESS_EXPIRES_MIN,
    });
  }),
);

const forgotSchema = z.object({ email: z.string().email() });

authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.json({ message: "If an account exists, reset instructions were sent." });
      return;
    }
    const raw = randomToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(raw), expiresAt },
    });
    await sendMail({
      to: user.email,
      subject: "JIDA password reset",
      text: `Use this token to reset your password (valid 1 hour): ${raw}\n\nSend POST /api/auth/reset-password with { "token", "newPassword" }.`,
    });
    res.json({ message: "If an account exists, reset instructions were sent." });
  }),
);

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

authRouter.post(
  "/reset-password",
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
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      prisma.passwordResetToken.deleteMany({ where: { userId: record.userId } }),
    ]);
    res.json({ message: "Password updated" });
  }),
);
