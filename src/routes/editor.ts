import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { EditorialDecisionType, FileSource, ManuscriptStatus, Role } from "@prisma/client";
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
  notifyAuthorEditedFile,
  notifyAuthorPublished,
  notifyAuthorStatus,
} from "../services/notifications.js";
import { slugify } from "../utils/slug.js";
import { manuscriptUpload } from "../utils/upload.js";
import { storedRolesGranting } from "../utils/roles.js";
import { toFullReview } from "../utils/reviewForm.js";
import { checkScholarReadiness, type ScholarSubject } from "../services/scholar.js";
import { sendReviewerAssignmentEmail } from "./reviewer.js";

export const editorRouter = Router();
// Chief and associate editors share this portal: both imply Role.EDITOR, so the
// single EDITOR requirement admits all three tiers.
editorRouter.use(authMiddleware, requireVerifiedEmail, requireRole(Role.EDITOR, Role.ADMIN));

/** FR-E3 — list available reviewers so editors can assign them. */
editorRouter.get(
  "/reviewers",
  asyncHandler(async (_req, res) => {
    const reviewers = await prisma.user.findMany({
      where: { roles: { hasSome: storedRolesGranting(Role.REVIEWER) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, firstName: true, lastName: true, affiliation: true },
    });
    res.json(reviewers);
  }),
);

editorRouter.get(
  "/submissions",
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined;
    const where =
      status && Object.values(ManuscriptStatus).includes(status as ManuscriptStatus)
        ? { status: status as ManuscriptStatus }
        : {};
    const list = await prisma.manuscript.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        author: {
          select: { id: true, email: true, firstName: true, lastName: true, affiliation: true },
        },
        files: { where: { isLatest: true }, take: 1 },
        coAuthors: { orderBy: { position: "asc" } },
        assignments: {
          orderBy: { createdAt: "asc" },
          include: {
            reviewer: { select: { id: true, email: true, firstName: true, lastName: true } },
            review: {
              include: { authorFeedback: { select: { rating: true, comment: true } } },
            },
          },
        },
        decisions: {
          orderBy: { createdAt: "desc" },
          include: { editor: { select: { firstName: true, lastName: true, email: true } } },
        },
      },
    });
    // The frontend's `EditorSubmission`/`Assignment` types expect flat
    // `authorName`/`recommendation` fields — Prisma only gives nested
    // relations, so map them here instead of leaving those fields undefined.
    const flattened = list.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      submittedAt: m.createdAt,
      authorName: [m.author.firstName, m.author.lastName].filter(Boolean).join(" ") || m.author.email,
      // Full contact details for the editor's author hover card.
      author: {
        id: m.author.id,
        name: [m.author.firstName, m.author.lastName].filter(Boolean).join(" ") || null,
        email: m.author.email,
        affiliation: m.author.affiliation,
      },
      coAuthors: m.coAuthors.map((c) => ({
        fullName: c.fullName,
        email: c.email,
        affiliation: c.affiliation,
        isCorresponding: c.isCorresponding,
      })),
      decisions: m.decisions.map((d) => ({
        decision: d.decision,
        notes: d.notes,
        createdAt: d.createdAt,
        editorName:
          [d.editor.firstName, d.editor.lastName].filter(Boolean).join(" ") || d.editor.email,
      })),
      assignments: m.assignments.map((a) => ({
        id: a.id,
        manuscriptId: a.manuscriptId,
        deadline: a.deadline,
        progress: a.progress,
        recommendation: a.review?.recommendation,
        commentsToAuthor: a.review?.commentsToAuthor,
        commentsToEditor: a.review?.commentsToEditor,
        reviewId: a.review?.id,
        reviewedAt: a.review?.createdAt,
        hasAttachment: Boolean(a.review?.attachmentStoredName),
        // The editor sees the completed review form in full — ratings,
        // recommendation, author-facing comments and confidential notes.
        review: a.review ? toFullReview(a.review) : null,
        // "Authors' Feedback of Reviewer's Work to JIDA", for the editor to
        // judge how useful this reviewer's work was.
        authorFeedback: a.review?.authorFeedback ?? null,
        reviewer: a.reviewer
          ? {
              id: a.reviewer.id,
              email: a.reviewer.email,
              name: [a.reviewer.firstName, a.reviewer.lastName].filter(Boolean).join(" ") || undefined,
            }
          : undefined,
      })),
    }));
    res.json(flattened);
  }),
);

editorRouter.get(
  "/manuscripts/:id",
  asyncHandler(async (req, res) => {
    const m = await prisma.manuscript.findUnique({
      where: { id: req.params.id },
      include: {
        author: { select: { id: true, email: true, firstName: true, lastName: true, affiliation: true } },
        files: { orderBy: { versionLabel: "desc" } },
        assignments: {
          include: {
            reviewer: { select: { id: true, email: true, firstName: true, lastName: true } },
            review: true,
          },
        },
        decisions: { orderBy: { createdAt: "desc" }, take: 5 },
        publication: true,
      },
    });
    if (!m) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(m);
  }),
);

const assignSchema = z.object({
  assignments: z
    .array(
      z.object({
        reviewerId: z.string().uuid(),
        deadline: z.coerce.date(),
      }),
    )
    .min(1),
});

editorRouter.post(
  "/manuscripts/:id/assign-reviewers",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = assignSchema.parse(req.body);
    const manuscript = await prisma.manuscript.findUnique({ where: { id: req.params.id } });
    if (!manuscript) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }

    const reviewerIds = [...new Set(body.assignments.map((a) => a.reviewerId))];
    const reviewers = await prisma.user.findMany({
      where: {
        id: { in: reviewerIds },
        roles: { hasSome: storedRolesGranting(Role.REVIEWER) },
      },
    });
    if (reviewers.length !== reviewerIds.length) {
      res.status(400).json({ error: "One or more invalid reviewer ids" });
      return;
    }

    for (const a of body.assignments) {
      await prisma.reviewAssignment.upsert({
        where: {
          manuscriptId_reviewerId: { manuscriptId: manuscript.id, reviewerId: a.reviewerId },
        },
        create: {
          manuscriptId: manuscript.id,
          reviewerId: a.reviewerId,
          assignedById: req.user!.id,
          deadline: a.deadline,
        },
        update: { deadline: a.deadline, assignedById: req.user!.id },
      });
      await sendReviewerAssignmentEmail(a.reviewerId, manuscript.title, a.deadline);
    }

    await prisma.manuscript.update({
      where: { id: manuscript.id },
      data: { status: ManuscriptStatus.UNDER_REVIEW },
    });

    const author = await prisma.user.findUniqueOrThrow({ where: { id: manuscript.authorId } });
    await notifyAuthorStatus(author.email, manuscript.title, ManuscriptStatus.UNDER_REVIEW);

    const updated = await prisma.manuscript.findUniqueOrThrow({
      where: { id: manuscript.id },
      include: { assignments: { include: { reviewer: true, review: true } } },
    });
    res.json(updated);
  }),
);

/** Unassign a reviewer. Refuses to drop a completed review — that's data, not a stray link. */
editorRouter.delete(
  "/manuscripts/:id/assignments/:reviewerId",
  asyncHandler(async (req, res) => {
    const assignment = await prisma.reviewAssignment.findUnique({
      where: {
        manuscriptId_reviewerId: {
          manuscriptId: req.params.id,
          reviewerId: req.params.reviewerId,
        },
      },
      include: { review: true },
    });
    if (!assignment) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    if (assignment.review) {
      res.status(409).json({
        error: "Cannot unassign — a review has already been submitted for this manuscript.",
      });
      return;
    }
    await prisma.reviewAssignment.delete({ where: { id: assignment.id } });
    res.status(204).end();
  }),
);

const decisionSchema = z.object({
  decision: z.nativeEnum(EditorialDecisionType),
  notes: z.string().optional(),
});

editorRouter.post(
  "/manuscripts/:id/decision",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = decisionSchema.parse(req.body);
    const manuscript = await prisma.manuscript.findUnique({ where: { id: req.params.id } });
    if (!manuscript) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }

    let nextStatus: ManuscriptStatus;
    switch (body.decision) {
      case EditorialDecisionType.ACCEPT:
        nextStatus = ManuscriptStatus.ACCEPTED;
        break;
      case EditorialDecisionType.REJECT:
        nextStatus = ManuscriptStatus.REJECTED;
        break;
      case EditorialDecisionType.REQUEST_REVISION:
        nextStatus = ManuscriptStatus.REVISION_REQUIRED;
        break;
      default:
        nextStatus = manuscript.status;
    }

    await prisma.$transaction([
      prisma.editorialDecision.create({
        data: {
          manuscriptId: manuscript.id,
          editorId: req.user!.id,
          decision: body.decision,
          notes: body.notes,
        },
      }),
      prisma.manuscript.update({
        where: { id: manuscript.id },
        data: { status: nextStatus },
      }),
    ]);

    const author = await prisma.user.findUniqueOrThrow({ where: { id: manuscript.authorId } });
    await notifyAuthorStatus(author.email, manuscript.title, nextStatus);

    const updated = await prisma.manuscript.findUniqueOrThrow({ where: { id: manuscript.id } });
    res.json(updated);
  }),
);

const issueSchema = z.object({
  volume: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
  year: z.number().int().min(1900).max(2100),
  title: z.string().optional(),
});

editorRouter.post(
  "/issues",
  asyncHandler(async (req, res) => {
    const body = issueSchema.parse(req.body);
    const issue = await prisma.issue.upsert({
      where: {
        volume_issueNumber_year: {
          volume: body.volume,
          issueNumber: body.issueNumber,
          year: body.year,
        },
      },
      create: body,
      update: { ...(body.title ? { title: body.title } : {}) },
    });
    res.status(201).json(issue);
  }),
);

const publishSchema = z.object({
  manuscriptId: z.string().uuid(),
});

editorRouter.post(
  "/issues/:issueId/publish",
  asyncHandler(async (req, res) => {
    const body = publishSchema.parse(req.body);
    const issue = await prisma.issue.findUnique({ where: { id: req.params.issueId } });
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const manuscript = await prisma.manuscript.findUnique({ where: { id: body.manuscriptId } });
    if (!manuscript || manuscript.status !== ManuscriptStatus.ACCEPTED) {
      res.status(400).json({ error: "Manuscript must be accepted before publication" });
      return;
    }
    const existing = await prisma.publication.findUnique({ where: { manuscriptId: manuscript.id } });
    if (existing) {
      res.status(400).json({ error: "Manuscript already published" });
      return;
    }

    const slug = slugify(manuscript.title, manuscript.id);
    const publication = await prisma.publication.create({
      data: {
        issueId: issue.id,
        manuscriptId: manuscript.id,
        slug,
      },
      include: { issue: true, manuscript: { select: { title: true, abstract: true, keywords: true } } },
    });

    const author = await prisma.user.findUniqueOrThrow({ where: { id: manuscript.authorId } });
    await notifyAuthorPublished(author.email, manuscript.title, slug);

    res.status(201).json(publication);
  }),
);

const scholarSchema = z.object({ scholarReady: z.boolean() });

/** Loads everything the Scholar checks need for one publication. */
async function loadScholarSubject(publicationId: string) {
  const pub = await prisma.publication.findUnique({
    where: { id: publicationId },
    include: {
      issue: true,
      manuscript: {
        include: {
          author: { select: { firstName: true, lastName: true, affiliation: true } },
          coAuthors: { orderBy: { position: "asc" } },
          files: { where: { isLatest: true }, take: 1 },
        },
      },
    },
  });
  if (!pub) return null;

  const file = pub.manuscript.files[0];
  return {
    publication: pub,
    subject: {
      title: pub.manuscript.title,
      abstract: pub.manuscript.abstract,
      keywords: pub.manuscript.keywords,
      references: pub.manuscript.references,
      author: pub.manuscript.author,
      coAuthors: pub.manuscript.coAuthors.map((c) => ({
        fullName: c.fullName,
        affiliation: c.affiliation,
      })),
      issue: pub.issue,
      file: file ? { originalName: file.originalName, mimeType: file.mimeType } : null,
    } satisfies ScholarSubject,
  };
}

/** Dry run — lets the editor see what stands between an article and Scholar. */
editorRouter.get(
  "/publications/:id/scholar-check",
  asyncHandler(async (req, res) => {
    const loaded = await loadScholarSubject(req.params.id);
    if (!loaded) {
      res.status(404).json({ error: "Publication not found" });
      return;
    }
    res.json(checkScholarReadiness(loaded.subject));
  }),
);

editorRouter.patch(
  "/publications/:id/scholar",
  asyncHandler(async (req, res) => {
    const body = scholarSchema.parse(req.body);
    const loaded = await loadScholarSubject(req.params.id);
    if (!loaded) {
      res.status(404).json({ error: "Publication not found" });
      return;
    }

    // Turning the flag ON is what makes the page emit citation_* tags. Refuse
    // when the article cannot actually be indexed: a flag set over a DOCX or a
    // missing abstract produces metadata Scholar will reject, and nobody would
    // find out until the article failed to appear.
    const readiness = checkScholarReadiness(loaded.subject);
    if (body.scholarReady && !readiness.ready) {
      res.status(400).json({
        error: "This article does not yet meet Google Scholar's requirements.",
        code: "SCHOLAR_NOT_READY",
        ...readiness,
      });
      return;
    }

    const pub = await prisma.publication.update({
      where: { id: req.params.id },
      data: { scholarReady: body.scholarReady },
    });
    res.json({ ...pub, ...readiness });
  }),
);

const settingsSchema = z.object({
  submissionDeadline: z.coerce.date().nullable().optional(),
  openForSubmissions: z.boolean().optional(),
});

editorRouter.patch(
  "/settings",
  asyncHandler(async (req, res) => {
    const body = settingsSchema.parse(req.body);
    const s = await prisma.journalSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        submissionDeadline: body.submissionDeadline ?? undefined,
        openForSubmissions: body.openForSubmissions ?? true,
      },
      update: {
        ...(body.submissionDeadline !== undefined && { submissionDeadline: body.submissionDeadline }),
        ...(body.openForSubmissions !== undefined && { openForSubmissions: body.openForSubmissions }),
      },
    });
    res.json(s);
  }),
);

/** Editor download of manuscript file (same as reviewer). */
editorRouter.get(
  "/manuscripts/:id/download",
  asyncHandler(async (req, res) => {
    const file = await prisma.manuscriptFile.findFirst({
      where: { manuscriptId: req.params.id, isLatest: true },
    });
    if (!file) {
      res.status(404).json({ error: "File not found" });
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

const editedFileSchema = z.object({
  remarks: z.string().min(1, "Remarks are required"),
});

/** Editor uploads a new version of the manuscript with remarks for the author. */
editorRouter.post(
  "/manuscripts/:id/edited-file",
  manuscriptUpload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const body = editedFileSchema.parse(req.body);
    const manuscript = await prisma.manuscript.findUnique({ where: { id: req.params.id } });
    if (!manuscript) {
      res.status(404).json({ error: "Manuscript not found" });
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
          source: FileSource.EDITOR,
          remarks: body.remarks,
        },
      }),
    ]);

    const author = await prisma.user.findUniqueOrThrow({ where: { id: manuscript.authorId } });
    await notifyAuthorEditedFile(author.email, manuscript.title, body.remarks);

    const updated = await prisma.manuscript.findUniqueOrThrow({
      where: { id: manuscript.id },
      include: { files: { orderBy: { versionLabel: "desc" } } },
    });
    res.status(201).json(updated);
  }),
);

/** Editor download of a reviewer's attached file, if they included one with their review. */
editorRouter.get(
  "/reviews/:reviewId/download",
  asyncHandler(async (req, res) => {
    const review = await prisma.review.findUnique({ where: { id: req.params.reviewId } });
    if (!review || !review.attachmentStoredName) {
      res.status(404).json({ error: "No attachment for this review" });
      return;
    }
    const abs = path.join(env.UPLOAD_DIR, review.attachmentStoredName);
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "File missing on server" });
      return;
    }
    res.download(abs, review.attachmentOriginalName ?? review.attachmentStoredName);
  }),
);
