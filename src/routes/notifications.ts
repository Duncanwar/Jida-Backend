import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { authMiddleware, requireVerifiedEmail, type AuthedRequest } from "../middleware/auth.js";
import { hasAnyRole } from "../utils/roles.js";

export const notificationsRouter = Router();

// Every role uses this router for its own reminders, so there is no
// `requireRole` restriction — only that the account is authenticated and
// verified, same as every other protected route.
notificationsRouter.use(authMiddleware, requireVerifiedEmail);

/**
 * Whether `userId` may set a reminder on `manuscriptId`. Mirrors the access
 * rules already enforced separately in manuscripts.ts (author), reviewer.ts
 * (assigned reviewer), and editor.ts (editor tier) — this is the one place
 * that needs to check all three, since any role can reach this router.
 */
async function canAccessManuscript(
  user: NonNullable<AuthedRequest["user"]>,
  manuscriptId: string,
): Promise<boolean> {
  if (hasAnyRole(user.roles, [Role.EDITOR, Role.ADMIN])) return true;

  const manuscript = await prisma.manuscript.findUnique({
    where: { id: manuscriptId },
    select: {
      authorId: true,
      assignments: { where: { reviewerId: user.id }, select: { id: true }, take: 1 },
    },
  });
  if (!manuscript) return false;
  return manuscript.authorId === user.id || manuscript.assignments.length > 0;
}

const reminderSchema = z.object({
  manuscriptId: z.string().min(1),
  remindAt: z.coerce.date(),
  note: z.string().trim().min(1, "A reminder needs a note").max(500),
});

/** Sets an in-app reminder on a manuscript. Becomes visible in GET / once
 * `visibleAt` passes — no email, no background job. */
notificationsRouter.post(
  "/reminders",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = reminderSchema.parse(req.body);

    if (!(await canAccessManuscript(req.user!, body.manuscriptId))) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }

    const manuscript = await prisma.manuscript.findUniqueOrThrow({
      where: { id: body.manuscriptId },
      select: { title: true },
    });

    const notification = await prisma.notification.create({
      data: {
        userId: req.user!.id,
        manuscriptId: body.manuscriptId,
        title: `Reminder: ${manuscript.title}`,
        body: body.note,
        visibleAt: body.remindAt,
      },
    });
    res.status(201).json(notification);
  }),
);

/** The signed-in user's notifications that have come due, newest first. */
notificationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const where = { userId: req.user!.id, visibleAt: { lte: new Date() } };
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { visibleAt: "desc" },
        take: 50,
        include: { manuscript: { select: { id: true, title: true } } },
      }),
      prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    res.json({ items, unreadCount });
  }),
);

notificationsRouter.patch(
  "/:id/read",
  asyncHandler(async (req: AuthedRequest, res) => {
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.status(204).end();
  }),
);

notificationsRouter.patch(
  "/read-all",
  asyncHandler(async (req: AuthedRequest, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.status(204).end();
  }),
);
