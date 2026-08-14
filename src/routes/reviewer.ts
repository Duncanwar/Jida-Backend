import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { ReviewerProgress, Role, type Review } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import {
  authMiddleware,
  requireRole,
  requireVerifiedEmail,
  type AuthedRequest,
} from "../middleware/auth.js";
import { notifyEditorPendingDecision, notifyReviewerAssigned } from "../services/notifications.js";
import { manuscriptUpload } from "../utils/upload.js";
import { storedRolesGranting } from "../utils/roles.js";
import { reviewFormSchema, toFullReview } from "../utils/reviewForm.js";

export const reviewerRouter = Router();
reviewerRouter.use(authMiddleware, requireVerifiedEmail, requireRole(Role.REVIEWER, Role.ADMIN));

/** Shared shape for the reviewer's `Assignment[]` type — flattens the nested
 * `manuscript`/`review` relations the frontend expects at the top level. */
function toAssignmentDTO(a: {
  id: string;
  manuscriptId: string;
  deadline: Date;
  progress: string;
  manuscript: { id: string; title: string; abstract: string; keywords: string[]; createdAt: Date };
  review: Review | null;
}) {
  return {
    id: a.id,
    manuscriptId: a.manuscriptId,
    manuscriptTitle: a.manuscript.title,
    abstract: a.manuscript.abstract,
    keywords: a.manuscript.keywords,
    submittedAt: a.manuscript.createdAt,
    deadline: a.deadline,
    progress: a.progress,
    recommendation: a.review?.recommendation,
    commentsToAuthor: a.review?.commentsToAuthor,
    commentsToEditor: a.review?.commentsToEditor,
    // The reviewer reads back their own completed form in full.
    review: a.review ? toFullReview(a.review) : null,
  };
}

reviewerRouter.get(
  "/assignments",
  asyncHandler(async (req: AuthedRequest, res) => {
    const list = await prisma.reviewAssignment.findMany({
      where: { reviewerId: req.user!.id },
      // Newest submission first — the queue is ordered by when the manuscript
      // was submitted, not by review deadline.
      orderBy: { manuscript: { createdAt: "desc" } },
      include: {
        manuscript: {
          select: {
            id: true,
            title: true,
            abstract: true,
            keywords: true,
            status: true,
            createdAt: true,
            author: { select: { firstName: true, lastName: true, affiliation: true } },
          },
        },
        review: true,
      },
    });
    res.json(list.map(toAssignmentDTO));
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
      include: { manuscript: true, review: true },
    });
    res.json(toAssignmentDTO(row));
  }),
);

reviewerRouter.post(
  "/assignments/:id/review",
  manuscriptUpload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    // The reviewer fills in the JIDA Manuscript Review Form; every section it
    // marks as required is validated here before anything is stored.
    const body = reviewFormSchema.parse(req.body);
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
          specificSuggestions: body.specificSuggestions || null,
          commentsToEditor: body.commentsToEditor || null,
          recommendation: body.recommendation,
          ratingTitle: body.ratingTitle,
          ratingAbstract: body.ratingAbstract,
          ratingLiterature: body.ratingLiterature,
          ratingMethods: body.ratingMethods,
          ratingConclusions: body.ratingConclusions,
          ratingReferences: body.ratingReferences,
          ratingStructure: body.ratingStructure,
          ...(req.file
            ? {
                attachmentStoredName: req.file.filename,
                attachmentOriginalName: req.file.originalname,
                attachmentMimeType: req.file.mimetype,
                attachmentSizeBytes: req.file.size,
              }
            : {}),
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
      const editors = await prisma.user.findMany({
        where: { roles: { hasSome: storedRolesGranting(Role.EDITOR) } },
        select: { email: true },
      });
      await Promise.all(
        editors.map((e) => notifyEditorPendingDecision(e.email, manuscript.title)),
      );
    }

    res.status(201).json(toFullReview(review));
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
    // Same `Assignment[]`-shaped DTO as /assignments — the frontend's History
    // tab reads `manuscriptTitle`/`recommendation` at the top level, but a
    // `Review` row nests everything under `assignment`/`assignment.manuscript`.
    const flattened = reviews.map((r) => ({
      id: r.id,
      manuscriptId: r.assignment.manuscript.id,
      manuscriptTitle: r.assignment.manuscript.title,
      deadline: r.assignment.deadline,
      progress: r.assignment.progress,
      recommendation: r.recommendation,
      commentsToAuthor: r.commentsToAuthor,
      commentsToEditor: r.commentsToEditor,
      review: toFullReview(r),
    }));
    res.json(flattened);
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
