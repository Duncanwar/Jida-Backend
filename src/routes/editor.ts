import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import {
  AssignmentResponse,
  DecisionStage,
  EditorialDecisionType,
  FileSource,
  InvitationStatus,
  ManuscriptStatus,
  Role,
} from "@prisma/client";
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
  notifyEditorsOfDecision,
  notifyReviewerInvitation,
  notifyReviewerOfFinalDecision,
} from "../services/notifications.js";
import { slugify } from "../utils/slug.js";
import { randomUUID } from "node:crypto";
import { manuscriptUpload } from "../utils/upload.js";
import { storedRolesGranting } from "../utils/roles.js";
import { toFullReview } from "../utils/reviewForm.js";
import { checkScholarReadiness, type ScholarSubject } from "../services/scholar.js";
import { sendReviewerAssignmentEmail } from "./reviewer.js";
import { hashToken, randomToken } from "../utils/cryptoToken.js";
import { broadcastAnnouncement, broadcastIssue } from "../services/newsletter.js";

/** A manuscript may carry at most this many reviewers (FR — blind peer review). */
const MAX_REVIEWERS_PER_MANUSCRIPT = 2;

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

// ─── Reviewer invitations (FR — grow the reviewer pool) ────────────────────

const invitationSchema = z.object({
  email: z.string().email(),
  message: z.string().trim().min(1).max(4000),
});

/** Days a reviewer invitation link stays valid. */
const INVITATION_TTL_DAYS = 7;

/** Editor invites anyone by email to become a JIDA reviewer. */
editorRouter.post(
  "/reviewer-invitations",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = invitationSchema.parse(req.body);
    const rawToken = randomToken();
    const inviter = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    const invitation = await prisma.reviewerInvitation.create({
      data: {
        email: body.email.toLowerCase(),
        message: body.message,
        invitedById: req.user!.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    await notifyReviewerInvitation({
      email: invitation.email,
      inviterName: [inviter.firstName, inviter.lastName].filter(Boolean).join(" ") || inviter.email,
      message: body.message,
      rawToken,
    });
    res.status(201).json({
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    });
  }),
);

/** The editor's own sent invitations, newest first — the Peer Review tracking list. */
editorRouter.get(
  "/reviewer-invitations",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await prisma.reviewerInvitation.findMany({
      where: { invitedById: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        email: true,
        status: true,
        declineReason: true,
        respondedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    // Surface expiry without a background job — a still-PENDING row past its
    // date reads as EXPIRED.
    const now = Date.now();
    res.json(
      rows.map((r) => ({
        ...r,
        status:
          r.status === InvitationStatus.PENDING && r.expiresAt.getTime() < now
            ? InvitationStatus.EXPIRED
            : r.status,
      })),
    );
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
      submissionDeadline: m.submissionDeadline,
      isRevised: m.isRevised,
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
        stage: d.stage,
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
        response: a.response,
        declineReason: a.declineReason,
        respondedAt: a.respondedAt,
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

    // A manuscript may carry at most two reviewers. Count the reviewers it
    // would end up with — those already assigned, plus any new ones in this
    // request — and refuse if that exceeds the cap.
    const existing = await prisma.reviewAssignment.findMany({
      where: { manuscriptId: manuscript.id },
      select: { reviewerId: true },
    });
    const resulting = new Set<string>([...existing.map((e) => e.reviewerId), ...reviewerIds]);
    if (resulting.size > MAX_REVIEWERS_PER_MANUSCRIPT) {
      res.status(400).json({
        error: `A manuscript can have at most ${MAX_REVIEWERS_PER_MANUSCRIPT} reviewers.`,
      });
      return;
    }

    for (const a of body.assignments) {
      const wasNew = !existing.some((e) => e.reviewerId === a.reviewerId);
      const assignment = await prisma.reviewAssignment.upsert({
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
      // Only (re)send the accept/decline invitation for a genuinely new
      // assignment — bumping a deadline should not re-prompt a reviewer who
      // already accepted.
      if (wasNew) {
        await sendReviewerAssignmentEmail(assignment.id, a.reviewerId, manuscript.title, a.deadline);
      }
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
  /// Which pass through the pipeline this decision belongs to. Optional for
  /// backward compatibility with any caller that predates the distinction —
  /// omitting it just skips the stage-specific extra notification below.
  stage: z.nativeEnum(DecisionStage).optional(),
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
        // Initial screening's "accept" means "send to peer review", not
        // "ready to publish" — that only happens at final screening.
        nextStatus =
          body.stage === DecisionStage.INITIAL_SCREENING
            ? ManuscriptStatus.UNDER_REVIEW
            : ManuscriptStatus.ACCEPTED;
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
          stage: body.stage,
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

    // Initial screening notes are meant for the author and the rest of the
    // editorial team; final screening notes are meant for the reviewer(s)
    // whose evaluation drove the decision, plus the rest of the team.
    if (body.stage === DecisionStage.INITIAL_SCREENING) {
      await notifyEditorsOfDecision(manuscript.title, body.decision, body.notes, req.user!.id);
    } else if (body.stage === DecisionStage.FINAL_SCREENING) {
      await notifyReviewerOfFinalDecision(
        manuscript.id,
        manuscript.title,
        body.decision,
        body.notes,
        req.user!.id,
      );
    }

    const updated = await prisma.manuscript.findUniqueOrThrow({ where: { id: manuscript.id } });
    res.json(updated);
  }),
);

const issueSchema = z.object({
  volume: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
  year: z.number().int().min(1900).max(2100),
  title: z.string().optional(),
  specialIssue: z.boolean().optional(),
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
      update: {
        ...(body.title ? { title: body.title } : {}),
        ...(body.specialIssue !== undefined ? { specialIssue: body.specialIssue } : {}),
      },
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

const announcementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  submissionDeadline: z.coerce.date().nullable().optional(),
  openForSubmissions: z.boolean().optional(),
  /** Also email this to the public newsletter list — e.g. a call for papers. */
  notifySubscribers: z.boolean().optional(),
  /** Publish it on the public site, where anyone — and Google — can read it. */
  isPublic: z.boolean().optional(),
});

/**
 * Broadcasts a submission-period announcement to every user — author,
 * reviewer, and editor dashboards alike — and, if given, updates the
 * journal-wide submission deadline / open flag that drives the "submissions
 * open" banner. One Notification row per recipient, sent exactly once
 * (including to the posting editor themselves, so their own notification
 * feed doubles as announcement history — no separate history endpoint
 * needed). An announcement is identified purely by `manuscriptId: null` —
 * there is no separate announcement table.
 */
editorRouter.post(
  "/announcements",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = announcementSchema.parse(req.body);

    if (body.submissionDeadline !== undefined || body.openForSubmissions !== undefined) {
      await prisma.journalSettings.upsert({
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
    }

    // The announcement itself, kept whether or not it is public: it is the
    // journal's own record, and it can be published later.
    const announcement = await prisma.announcement.create({
      data: {
        slug: slugify(body.title, randomUUID()),
        title: body.title,
        body: body.body,
        isPublic: body.isPublic ?? false,
        createdById: req.user?.id ?? null,
      },
    });

    // Every real account gets it exactly once, including the posting editor
    // — no separate "confirmation row" hack, and no double-count for an
    // account that holds more than one role.
    const recipients = await prisma.user.findMany({ select: { id: true } });
    const visibleAt = new Date();
    await prisma.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.id,
        title: body.title,
        body: body.body,
        visibleAt,
      })),
    });

    // A call for papers is worth nothing if it only reaches people who already
    // have an account. When asked, the same text also goes to the public
    // newsletter list. Best-effort — the announcement is already posted.
    const newsletter = body.notifySubscribers
      ? await broadcastAnnouncement({ title: body.title, body: body.body })
      : { recipients: 0, delivered: 0 };

    res.status(201).json({
      recipientCount: recipients.length,
      newsletter,
      announcement: { id: announcement.id, slug: announcement.slug, isPublic: announcement.isPublic },
    });
  }),
);
/**
 * Tells the public newsletter list that an issue is published.
 *
 * Deliberately a separate action rather than a side effect of publishing a
 * manuscript: articles go into an issue one at a time, so mailing on each
 * publish would send readers one email per article. The editor decides when the
 * issue is complete enough to announce.
 */
editorRouter.post(
  "/issues/:issueId/notify-subscribers",
  asyncHandler(async (req, res) => {
    const issue = await prisma.issue.findUnique({ where: { id: req.params.issueId } });
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const result = await broadcastIssue(issue.id);
    res.json(result);
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

/**
 * Editor uploads a new version of the manuscript with remarks for the
 * author. The file itself is optional — an editor may want to leave remarks
 * without attaching a revised file, e.g. pointing the author to fix
 * something themselves.
 */
editorRouter.post(
  "/manuscripts/:id/edited-file",
  manuscriptUpload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = editedFileSchema.parse(req.body);
    const manuscript = await prisma.manuscript.findUnique({ where: { id: req.params.id } });
    if (!manuscript) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }

    if (req.file) {
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
    }

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
