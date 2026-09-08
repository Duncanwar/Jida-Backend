import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { AssignmentResponse, ReviewerProgress, Role, type Review } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import {
  authMiddleware,
  requireRole,
  requireVerifiedEmail,
  type AuthedRequest,
} from "../middleware/auth.js";
import {
  clearAssignmentActionNotifications,
  notifyEditorAssignmentResponse,
  notifyEditorPendingDecision,
  notifyReviewerAssigned,
} from "../services/notifications.js";
import { manuscriptUpload } from "../utils/upload.js";
import { storedRolesGranting } from "../utils/roles.js";
import { reviewFormSchema, toFullReview } from "../utils/reviewForm.js";
import { hashToken, randomToken } from "../utils/cryptoToken.js";

export const reviewerRouter = Router();
reviewerRouter.use(authMiddleware, requireVerifiedEmail, requireRole(Role.REVIEWER, Role.ADMIN));

/** Shared shape for the reviewer's `Assignment[]` type — flattens the nested
 * `manuscript`/`review` relations the frontend expects at the top level. */
function toAssignmentDTO(a: {
  id: string;
  manuscriptId: string;
  deadline: Date;
  progress: string;
  response?: string;
  declineReason?: string | null;
  respondedAt?: Date | null;
  manuscript: {
    id: string;
    title: string;
    abstract: string;
    keywords: string[];
    createdAt: Date;
    submissionDeadline?: Date | null;
    isRevised?: boolean;
  };
  review: Review | null;
}) {
  return {
    id: a.id,
    manuscriptId: a.manuscriptId,
    manuscriptTitle: a.manuscript.title,
    manuscriptIsRevised: a.manuscript.isRevised ?? false,
    abstract: a.manuscript.abstract,
    keywords: a.manuscript.keywords,
    submittedAt: a.manuscript.createdAt,
    submissionDeadline: a.manuscript.submissionDeadline,
    deadline: a.deadline,
    progress: a.progress,
    response: a.response ?? "PENDING",
    declineReason: a.declineReason ?? null,
    respondedAt: a.respondedAt ?? null,
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
            isRevised: true,
            createdAt: true,
            submissionDeadline: true,
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

const respondSchema = z
  .object({
    accept: z.boolean(),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.accept || (v.reason && v.reason.length > 0), {
    message: "A reason is required when declining",
    path: ["reason"],
  });

/**
 * The reviewer accepts or declines an assignment from the in-app notification.
 * Declining keeps the row (with a reason) as a record and tells the editor;
 * the review form stays locked until the assignment is accepted.
 */
reviewerRouter.post(
  "/assignments/:id/respond",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = respondSchema.parse(req.body);
    const assignment = await prisma.reviewAssignment.findFirst({
      where: { id: req.params.id, reviewerId: req.user!.id },
      include: { manuscript: { select: { title: true } } },
    });
    if (!assignment) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (assignment.response !== AssignmentResponse.PENDING) {
      res.status(409).json({ error: `Assignment already ${assignment.response.toLowerCase()}` });
      return;
    }

    const updated = await prisma.reviewAssignment.update({
      where: { id: assignment.id },
      data: {
        response: body.accept ? AssignmentResponse.ACCEPTED : AssignmentResponse.DECLINED,
        declineReason: body.accept ? null : (body.reason ?? null),
        respondedAt: new Date(),
        responseToken: null,
      },
      include: { manuscript: true, review: true },
    });

    const reviewer = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    await clearAssignmentActionNotifications(assignment.id);
    await notifyEditorAssignmentResponse({
      editorId: assignment.assignedById,
      reviewerName:
        [reviewer.firstName, reviewer.lastName].filter(Boolean).join(" ") || reviewer.email,
      title: assignment.manuscript.title,
      accepted: body.accept,
      reason: body.reason,
    });

    res.json(toAssignmentDTO(updated));
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
    if (assignment.response === AssignmentResponse.DECLINED) {
      res.status(409).json({ error: "You declined this assignment" });
      return;
    }
    if (assignment.response === AssignmentResponse.PENDING) {
      res.status(409).json({ error: "Accept the assignment before submitting a review" });
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
            manuscript: {
              select: {
                id: true,
                title: true,
                status: true,
                createdAt: true,
                submissionDeadline: true,
              },
            },
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
      submittedAt: r.assignment.manuscript.createdAt,
      // History groups by submission period the same way the live queue does,
      // so it needs the deadline that was in effect when the manuscript came in.
      submissionDeadline: r.assignment.manuscript.submissionDeadline,
      reviewedAt: r.createdAt,
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

/**
 * Called by the editor workflow right after an assignment is created. Mints a
 * magic-link response token, stores its hash on the assignment, and notifies
 * the reviewer (in-app + email) with Accept / Decline. Exported for editor
 * route reuse.
 */
export async function sendReviewerAssignmentEmail(
  assignmentId: string,
  reviewerId: string,
  title: string,
  deadline: Date,
): Promise<void> {
  const reviewer = await prisma.user.findUniqueOrThrow({ where: { id: reviewerId } });
  const rawToken = randomToken();
  await prisma.reviewAssignment.update({
    where: { id: assignmentId },
    data: {
      responseToken: hashToken(rawToken),
      response: AssignmentResponse.PENDING,
      respondedAt: null,
      declineReason: null,
    },
  });
  await notifyReviewerAssigned({
    reviewerId,
    reviewerEmail: reviewer.email,
    assignmentId,
    rawResponseToken: rawToken,
    title,
    deadline,
  });
}
