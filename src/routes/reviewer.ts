import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { ReviewerProgress, Role, ReviewRecommendation } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { authMiddleware, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { notifyEditorPendingDecision, notifyReviewerAssigned } from "../services/notifications.js";

export const reviewerRouter = Router();
reviewerRouter.use(authMiddleware, requireRole(Role.REVIEWER));

reviewerRouter.get(
  "/assignments",
  asyncHandler(async (req: AuthedRequest, res) => {
    const list = await prisma.reviewAssignment.findMany({
      where: { reviewerId: req.user!.id },
      orderBy: { deadline: "asc" },
      include: {
        manuscript: {
          select: {
            id: true,
            title: true,
            abstract: true,
            keywords: true,
            status: true,
            author: { select: { firstName: true, lastName: true, affiliation: true } },
          },
        },
        review: true,
      },
    });
    res.json(list);
  }),
);

reviewerRouter.get(
  "/assignments/:id/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const assignment = await prisma.reviewAssignment.findFirst({
      where: { id: req.params.id, reviewerId: req.user!.id },
      include: {
        manuscript: {
          include: { files: { where: { isLatest: true }, take: 1 } },
        },
      },
    });
    if (!assignment) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    const file = assignment.manuscript.files[0];
    if (!file) {
      res.status(404).json({ error: "No manuscript file" });
      return;
    }
    const abs = path.join(env.UPLOAD_DIR, file.storedName);
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "File missing on server" });
      return;
    }
    res.download(abs, file.originalName);
  }),
);

const progressSchema = z.object({
  progress: z.nativeEnum(ReviewerProgress),
});

reviewerRouter.patch(
  "/assignments/:id/progress",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = progressSchema.parse(req.body);
    const updated = await prisma.reviewAssignment.updateMany({
      where: { id: req.params.id, reviewerId: req.user!.id },
      data: { progress: body.progress },
    });
    if (updated.count === 0) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    const row = await prisma.reviewAssignment.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { manuscript: true },
    });
    res.json(row);
  }),
);

const reviewSchema = z.object({
  commentsToAuthor: z.string().min(1),
  commentsToEditor: z.string().min(1),
  recommendation: z.nativeEnum(ReviewRecommendation),
});

reviewerRouter.post(
  "/assignments/:id/review",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = reviewSchema.parse(req.body);
    const assignment = await prisma.reviewAssignment.findFirst({
      where: { id: req.params.id, reviewerId: req.user!.id },
      include: { review: true },
    });
    if (!assignment) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (assignment.review) {
      res.status(400).json({ error: "Review already submitted" });
      return;
    }

    const review = await prisma.$transaction(async (tx) => {
      const r = await tx.review.create({
        data: {
          assignmentId: assignment.id,
          reviewerId: req.user!.id,
          commentsToAuthor: body.commentsToAuthor,
          commentsToEditor: body.commentsToEditor,
          recommendation: body.recommendation,
        },
      });
      await tx.reviewAssignment.update({
        where: { id: assignment.id },
        data: { progress: ReviewerProgress.FINISHED_REVIEW },
      });
      return r;
    });

    const all = await prisma.reviewAssignment.findMany({
      where: { manuscriptId: assignment.manuscriptId },
      include: { review: true },
    });
    const allDone = all.length > 0 && all.every((a) => a.review);
    if (allDone) {
      const manuscript = await prisma.manuscript.findUniqueOrThrow({
        where: { id: assignment.manuscriptId },
      });
      const editors = await prisma.user.findMany({ where: { role: "EDITOR" }, select: { email: true } });
      await Promise.all(
        editors.map((e) => notifyEditorPendingDecision(e.email, manuscript.title)),
      );
    }

    res.status(201).json(review);
  }),
);

reviewerRouter.get(
  "/history",
  asyncHandler(async (req: AuthedRequest, res) => {
    const reviews = await prisma.review.findMany({
      where: { reviewerId: req.user!.id },
      orderBy: { createdAt: "desc" },
      include: {
        assignment: {
          include: {
            manuscript: { select: { id: true, title: true, status: true } },
          },
        },
      },
    });
    res.json(reviews);
  }),
);

/** Called by editor workflow when assigning (exported for editor route reuse). */
export async function sendReviewerAssignmentEmail(
  reviewerId: string,
  title: string,
  deadline: Date,
): Promise<void> {
  const reviewer = await prisma.user.findUniqueOrThrow({ where: { id: reviewerId } });
  await notifyReviewerAssigned(reviewer.email, title, deadline);
}
