import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";

const patchSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  affiliation: z.string().optional(),
});

export const usersRouter = Router();

usersRouter.get(
  "/me",
  authMiddleware,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        affiliation: true,
        createdAt: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(user);
  }),
);

usersRouter.patch(
  "/me",
  authMiddleware,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = patchSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: body,
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        affiliation: true,
      },
    });
    res.json(user);
  }),
);
