import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { Role, type ReviewRecommendation } from "@prisma/client";
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
  notifyAuthorStatus,
  notifyAuthorSubmissionReceived,
  notifyEditorsNewSubmission,
} from "../services/notifications.js";
import { manuscriptUpload as upload } from "../utils/upload.js";

export const manuscriptsRouter = Router();

manuscriptsRouter.use(
  authMiddleware,
  requireVerifiedEmail,
  requireRole(Role.AUTHOR, Role.ADMIN),
);

/** Author-facing view of a review — the reviewer's identity and their private notes to the editor are dropped. */
interface AuthorVisibleReview {
  reviewId: string;
  reviewerLabel: string;
  recommendation: ReviewRecommendation;
  /** "Comments and Suggestions to the Author(s)" — the overall evaluation. */
  commentsToAuthor: string;
  /** The same section's reasons-and-suggestions prompt. */
  specificSuggestions: string | null;
  submittedAt: Date;
  /** The author's own "Feedback of Reviewer's Work to JIDA", once given. */
  feedback: { rating: number; comment: string | null } | null;
}

type AssignmentWithReview = {
  review: {
    id: string;
    recommendation: ReviewRecommendation;
    commentsToAuthor: string;
    specificSuggestions: string | null;
    createdAt: Date;
    authorFeedback: { rating: number; comment: string | null } | null;
  } | null;
};

/**
 * Reviewer feedback as the author is allowed to see it.
 *
 * Two things are deliberately withheld. The reviewer's name and their
 * `commentsToEditor` never cross this boundary — peer review is blind and those
 * notes are written for the editor alone. And nothing is released until an
 * editorial decision exists: until the editor has weighed the reviews, an
 * author acting on them would be responding to advice the journal has not
 * given yet.
 *
 * Reviewers are numbered in assignment order so the labels stay stable between
 * requests.
 */
function authorVisibleReviews(
  assignments: AssignmentWithReview[],
  hasDecision: boolean,
): AuthorVisibleReview[] {
  if (!hasDecision) return [];
  return assignments.flatMap((a, i) =>
    a.review
      ? [
          {
            reviewId: a.review.id,
            reviewerLabel: `Reviewer ${i + 1}`,
            recommendation: a.review.recommendation,
            commentsToAuthor: a.review.commentsToAuthor,
            specificSuggestions: a.review.specificSuggestions,
            submittedAt: a.review.createdAt,
            feedback: a.review.authorFeedback,
          },
        ]
      : [],
  );
}

const coAuthorSchema = z.object({
  fullName: z.string().min(1, "A co-author needs a name"),
  email: z.string().email("A co-author needs a valid email address"),
  affiliation: z.string().optional(),
  /** Marks a co-author who also fields correspondence about the manuscript. */
  isCorresponding: z.coerce.boolean().optional(),
});

type CoAuthorInput = z.infer<typeof coAuthorSchema>;

/**
 * Co-authors ride along in a multipart field, so they arrive as a JSON string
 * rather than a parsed array. Absent or empty means "no co-authors", which is
 * perfectly normal for a single-author submission.
 */
function parseCoAuthors(raw: unknown): CoAuthorInput[] {
  if (raw == null || raw === "") return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("co-authors must be a JSON array");
    }
  }
  if (!Array.isArray(parsed)) throw new Error("co-authors must be a JSON array");
  return z.array(coAuthorSchema).parse(parsed);
}

manuscriptsRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const title = req.body?.title as string | undefined;
    const abstract = req.body?.abstract as string | undefined;
    const keywordsRaw = req.body?.keywords as string | undefined;
    // A reference list is optional — many authors keep references in the
    // manuscript file itself rather than pasting them into the form.
    const references = req.body?.references as string | undefined;

    if (!req.file || !title || !abstract) {
      res.status(400).json({ error: "file, title, and abstract are required" });
      return;
    }

    // Co-authors arrive as a JSON array in a multipart field, since the rest of
    // the submission is a file upload.
    let coAuthors: CoAuthorInput[];
    try {
      coAuthors = parseCoAuthors(req.body?.coAuthors);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid co-authors" });
      return;
    }

    const settings = await prisma.journalSettings.upsert({
      where: { id: 1 },
      create: { id: 1, openForSubmissions: true },
      update: {},
    });
    if (!settings.openForSubmissions) {
      res.status(403).json({ error: "Submissions are currently closed" });
      return;
    }
    if (settings.submissionDeadline && new Date() > settings.submissionDeadline) {
      res.status(403).json({ error: "Submission deadline has passed" });
      return;
    }

    const keywords = (keywordsRaw ?? "")
      .split(/[,;]/)
      .map((k) => k.trim())
      .filter(Boolean);

    const manuscript = await prisma.manuscript.create({
      data: {
        authorId: req.user!.id,
        title,
        abstract,
        keywords,
        references: references?.trim() ? references : null,
        ...(coAuthors.length
          ? {
              coAuthors: {
                create: coAuthors.map((c, i) => ({
                  fullName: c.fullName,
                  email: c.email,
                  affiliation: c.affiliation ?? null,
                  isCorresponding: c.isCorresponding ?? false,
                  position: i,
                })),
              },
            }
          : {}),
        files: {
          create: {
            storedName: req.file.filename,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            sizeBytes: req.file.size,
            versionLabel: 1,
            isLatest: true,
          },
        },
      },
      include: { files: true, coAuthors: { orderBy: { position: "asc" } } },
    });

    const author = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { email: true, firstName: true, lastName: true },
    });
    const authorName = [author.firstName, author.lastName].filter(Boolean).join(" ") || null;
    const uploadedFile = manuscript.files[0];

    // Requirement 2 (FR-A3) — the author gets their own receipt in the inbox,
    // not just the editorial team. Both are non-blocking: the manuscript is
    // already stored, so a mail failure must not fail the upload.
    await Promise.all([
      notifyAuthorSubmissionReceived({
        email: author.email,
        name: authorName,
        title: manuscript.title,
        manuscriptId: manuscript.id,
        fileName: uploadedFile.originalName,
        fileSizeBytes: uploadedFile.sizeBytes,
        submittedAt: manuscript.createdAt,
        versionLabel: uploadedFile.versionLabel,
      }),
      notifyEditorsNewSubmission(manuscript.title, authorName),
    ]);

    res.status(201).json(manuscript);
  }),
);

manuscriptsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where = {
      authorId: req.user!.id,
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { abstract: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const list = await prisma.manuscript.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        files: { where: { isLatest: true }, take: 1 },
        publication: { select: { slug: true, publishedAt: true } },
        // The tracking table shows editorial remarks and reviewer feedback
        // inline, so the author does not have to open each manuscript to find
        // out what was said about it.
        decisions: {
          orderBy: { createdAt: "desc" },
          select: { decision: true, notes: true, createdAt: true },
        },
        coAuthors: { orderBy: { position: "asc" } },
        assignments: {
          orderBy: { createdAt: "asc" },
          include: {
            review: {
              include: { authorFeedback: { select: { rating: true, comment: true } } },
            },
          },
        },
      },
    });
    res.json(
      list.map(({ assignments, ...m }) => ({
        ...m,
        reviews: authorVisibleReviews(assignments, m.decisions.length > 0),
      })),
    );
  }),
);

/** Published article PDF/DOCX for author (FR-A8) — must be registered before `/:id`. */
manuscriptsRouter.get(
  "/published/:slug/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const pub = await prisma.publication.findUnique({
      where: { slug: req.params.slug },
      include: {
        manuscript: {
          include: { files: { where: { isLatest: true }, take: 1 } },
        },
      },
    });
    if (!pub || pub.manuscript.authorId !== req.user!.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const file = pub.manuscript.files[0];
    if (!file) {
      res.status(404).json({ error: "No file" });
      return;
    }
    const abs = path.join(env.UPLOAD_DIR, file.storedName);
    res.download(abs, file.originalName);
  }),
);

const reviewerFeedbackSchema = z.object({
  /** "Rating Result [Poor] 1-5 [Excellent]". */
  rating: z.coerce.number().int().min(1).max(5),
  /** "Specific evaluation to the Reviewer's review result". */
  comment: z.string().optional(),
});

/**
 * "Authors' Feedback of Reviewer's Work to JIDA" — the last section of the
 * review form, and the only one the author fills in. Upserted so an author can
 * correct a rating they have already given.
 *
 * Guarded the same way the reviewer comments themselves are: the author must
 * own the manuscript, and nothing can be rated until an editorial decision has
 * released the review to them.
 */
manuscriptsRouter.put(
  "/reviews/:reviewId/feedback",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = reviewerFeedbackSchema.parse(req.body);
    const review = await prisma.review.findUnique({
      where: { id: req.params.reviewId },
      include: {
        assignment: {
          include: {
            manuscript: { select: { authorId: true, _count: { select: { decisions: true } } } },
          },
        },
      },
    });

    if (!review || review.assignment.manuscript.authorId !== req.user!.id) {
      res.status(404).json({ error: "Review not found" });
      return;
    }
    if (review.assignment.manuscript._count.decisions === 0) {
      res.status(403).json({
        error: "This review is released once the editor reaches a decision.",
      });
      return;
    }

    const saved = await prisma.reviewerFeedback.upsert({
      where: { reviewId: review.id },
      create: {
        reviewId: review.id,
        authorId: req.user!.id,
        rating: body.rating,
        comment: body.comment?.trim() || null,
      },
      update: { rating: body.rating, comment: body.comment?.trim() || null },
      select: { rating: true, comment: true, createdAt: true, updatedAt: true },
    });
    res.json(saved);
  }),
);

manuscriptsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const m = await prisma.manuscript.findFirst({
      where: { id: req.params.id, authorId: req.user!.id },
      include: {
        files: { orderBy: { versionLabel: "desc" } },
        publication: true,
        coAuthors: { orderBy: { position: "asc" } },
        // So the author can see why a revision was requested or a decision
        // was made, not just the resulting status.
        decisions: {
          orderBy: { createdAt: "desc" },
          select: { decision: true, notes: true, createdAt: true },
        },
        assignments: {
          orderBy: { createdAt: "asc" },
          include: {
            review: {
              include: { authorFeedback: { select: { rating: true, comment: true } } },
            },
          },
        },
      },
    });
    if (!m) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }
    const { assignments, ...manuscript } = m;
    res.json({
      ...manuscript,
      reviews: authorVisibleReviews(assignments, manuscript.decisions.length > 0),
    });
  }),
);

manuscriptsRouter.post(
  "/:id/revisions",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const manuscript = await prisma.manuscript.findFirst({
      where: { id: req.params.id, authorId: req.user!.id },
    });
    if (!manuscript) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }
    if (manuscript.status !== "REVISION_REQUIRED") {
      res.status(400).json({ error: "Revisions only allowed when status is REVISION_REQUIRED" });
      return;
    }

    const latest = await prisma.manuscriptFile.findFirst({
      where: { manuscriptId: manuscript.id },
      orderBy: { versionLabel: "desc" },
    });
    const nextVersion = (latest?.versionLabel ?? 0) + 1;

    await prisma.$transaction([
      prisma.manuscriptFile.updateMany({
        where: { manuscriptId: manuscript.id },
        data: { isLatest: false },
      }),
      prisma.manuscriptFile.create({
        data: {
          manuscriptId: manuscript.id,
          storedName: req.file.filename,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          versionLabel: nextVersion,
          isLatest: true,
        },
      }),
      prisma.manuscript.update({
        where: { id: manuscript.id },
        data: { status: "UNDER_REVIEW" },
      }),
    ]);

    const author = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { email: true, firstName: true, lastName: true },
    });

    // Requirement 2 (FR-A3) — a revision upload is also an upload, so the
    // author receives a receipt for it alongside the status-change notice.
    await Promise.all([
      notifyAuthorSubmissionReceived({
        email: author.email,
        name: [author.firstName, author.lastName].filter(Boolean).join(" ") || null,
        title: manuscript.title,
        manuscriptId: manuscript.id,
        fileName: req.file.originalname,
        fileSizeBytes: req.file.size,
        submittedAt: new Date(),
        versionLabel: nextVersion,
        isRevision: true,
      }),
      notifyAuthorStatus(author.email, manuscript.title, "UNDER_REVIEW"),
    ]);

    const updated = await prisma.manuscript.findUniqueOrThrow({
      where: { id: manuscript.id },
      include: { files: { orderBy: { versionLabel: "desc" } } },
    });
    res.status(201).json(updated);
  }),
);

manuscriptsRouter.get(
  "/:id/files/:fileId/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.manuscriptFile.findFirst({
      where: {
        id: req.params.fileId,
        manuscript: { id: req.params.id, authorId: req.user!.id },
      },
    });
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const abs = path.join(env.UPLOAD_DIR, file.storedName);
    res.download(abs, file.originalName);
  }),
);
