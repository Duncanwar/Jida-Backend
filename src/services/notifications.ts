import { prisma } from "../lib/prisma.js";
import { sendMailSafe } from "./email.js";
import {
  assignmentInviteEmail,
  notificationEmail,
  reviewerInvitationEmail,
  submissionReceiptEmail,
} from "./emailTemplates.js";
import { env } from "../config/env.js";
import { storedRolesGranting } from "../utils/roles.js";
import { Role, type ManuscriptStatus } from "@prisma/client";

const appUrl = (): string => env.APP_URL.replace(/\/$/, "");

const authorDashboard = (): string => `${appUrl()}/author`;
const editorDashboard = (): string => `${appUrl()}/editor`;
const reviewerDashboard = (): string => `${appUrl()}/reviewer`;

/** The frontend landing page for an email magic-link accept/decline. */
export const invitationRespondUrl = (rawToken: string): string =>
  `${appUrl()}/invitations/${encodeURIComponent(rawToken)}`;

/**
 * Requirement 2 (FR-A3) — the author's own copy of a submission.
 *
 * The editorial team was already notified of new submissions; the author
 * received nothing, so there was no proof of receipt in their inbox. This is
 * that receipt, and it goes out for revisions as well as first submissions.
 *
 * Uses sendMailSafe: the manuscript is already committed at this point, and a
 * mail outage must not turn a successful upload into an error response.
 */
export async function notifyAuthorSubmissionReceived(params: {
  email: string;
  name?: string | null;
  title: string;
  manuscriptId: string;
  fileName: string;
  fileSizeBytes: number;
  submittedAt: Date;
  versionLabel?: number;
  isRevision?: boolean;
}): Promise<boolean> {
  const mail = submissionReceiptEmail({
    name: params.name,
    title: params.title,
    manuscriptId: params.manuscriptId,
    fileName: params.fileName,
    fileSizeBytes: params.fileSizeBytes,
    submittedAt: params.submittedAt,
    versionLabel: params.versionLabel,
    isRevision: params.isRevision,
    dashboardUrl: authorDashboard(),
  });
  return sendMailSafe({ to: params.email, ...mail });
}

export async function notifyEditorsNewSubmission(
  title: string,
  authorName?: string | null,
): Promise<void> {
  const editors = await prisma.user.findMany({
    where: { roles: { hasSome: storedRolesGranting(Role.EDITOR) } },
    select: { email: true },
  });
  const mail = notificationEmail({
    heading: "New manuscript submission",
    subject: "JIDA: new manuscript submission",
    lines: [
      `A new manuscript has been submitted: "${title}".`,
      ...(authorName ? [`Submitted by: ${authorName}.`] : []),
      "Open the editor dashboard to perform the initial check and assign reviewers.",
    ],
    actionUrl: editorDashboard(),
    actionLabel: "Open editor dashboard",
  });
  await Promise.all(editors.map((e) => sendMailSafe({ to: e.email, ...mail })));
}

export async function notifyAuthorStatus(
  email: string,
  title: string,
  status: ManuscriptStatus,
): Promise<void> {
  const readable = status.replace(/_/g, " ").toLowerCase();
  await sendMailSafe({
    to: email,
    ...notificationEmail({
      heading: "Manuscript status updated",
      subject: `JIDA: manuscript status update — ${status}`,
      lines: [
        `The status of your manuscript "${title}" is now: ${readable}.`,
        "Open your dashboard for the full history and any reviewer comments.",
      ],
      actionUrl: authorDashboard(),
      actionLabel: "View my submissions",
    }),
  });
}

/** Editor uploaded a new file version (with remarks) on top of the author's submission. */
export async function notifyAuthorEditedFile(
  email: string,
  title: string,
  remarks: string,
): Promise<void> {
  await sendMailSafe({
    to: email,
    ...notificationEmail({
      heading: "Editor uploaded a revised file",
      subject: `JIDA: an edited version of "${title}" is ready`,
      lines: [
        `An editor has uploaded a new version of your manuscript "${title}", with the following remarks:`,
        remarks,
      ],
      actionUrl: authorDashboard(),
      actionLabel: "View my submission",
    }),
  });
}

/**
 * A reviewer has just been assigned a manuscript. Drops an in-app
 * notification carrying the assignment id (so the bell can show Accept /
 * Decline) and emails the same choice as a tokenised magic link.
 */
export async function notifyReviewerAssigned(params: {
  reviewerId: string;
  reviewerEmail: string;
  assignmentId: string;
  rawResponseToken: string;
  title: string;
  deadline: Date;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: params.reviewerId,
      title: "New review assignment",
      body: `You have been asked to review "${params.title}". Accept or decline to continue.`,
      kind: "REVIEW_ASSIGNMENT",
      refId: params.assignmentId,
      visibleAt: new Date(),
    },
  });
  await sendMailSafe({
    to: params.reviewerEmail,
    ...assignmentInviteEmail({
      title: params.title,
      deadline: params.deadline,
      respondUrl: invitationRespondUrl(params.rawResponseToken),
      dashboardUrl: reviewerDashboard(),
    }),
  });
}

/**
 * Once a reviewer has answered an assignment, the "Accept / Decline" buttons
 * on their in-app notification are spent — collapse the row back to a plain
 * read notification so it cannot be actioned again.
 */
export async function clearAssignmentActionNotifications(assignmentId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { kind: "REVIEW_ASSIGNMENT", refId: assignmentId },
    data: { kind: "GENERIC", readAt: new Date() },
  });
}

/** Editor's invitation for someone to become a JIDA reviewer. */
export async function notifyReviewerInvitation(params: {
  email: string;
  inviterName: string;
  message: string;
  rawToken: string;
}): Promise<boolean> {
  return sendMailSafe({
    to: params.email,
    ...reviewerInvitationEmail({
      inviterName: params.inviterName,
      message: params.message,
      respondUrl: invitationRespondUrl(params.rawToken),
    }),
  });
}

/** Tells the assigning editor whether a reviewer took or turned down an assignment. */
export async function notifyEditorAssignmentResponse(params: {
  editorId: string;
  reviewerName: string;
  title: string;
  accepted: boolean;
  reason?: string | null;
}): Promise<void> {
  const editor = await prisma.user.findUnique({ where: { id: params.editorId } });
  const verb = params.accepted ? "accepted" : "declined";
  await prisma.notification.create({
    data: {
      userId: params.editorId,
      title: `Reviewer ${verb} an assignment`,
      body:
        `${params.reviewerName} ${verb} the review of "${params.title}".` +
        (!params.accepted && params.reason ? ` Reason: ${params.reason}` : ""),
      kind: "ASSIGNMENT_RESPONSE",
      visibleAt: new Date(),
    },
  });
  if (editor) {
    await sendMailSafe({
      to: editor.email,
      ...notificationEmail({
        heading: `Reviewer ${verb} an assignment`,
        subject: `JIDA: reviewer ${verb} — "${params.title}"`,
        lines: [
          `${params.reviewerName} ${verb} the review of "${params.title}".`,
          ...(!params.accepted && params.reason ? [`Reason given: ${params.reason}`] : []),
        ],
        actionUrl: editorDashboard(),
        actionLabel: "Open editor dashboard",
      }),
    });
  }
}

/** Tells the inviting editor whether a reviewer invitation was taken up. */
export async function notifyEditorInvitationResponse(params: {
  editorId: string;
  email: string;
  accepted: boolean;
  reason?: string | null;
}): Promise<void> {
  const editor = await prisma.user.findUnique({ where: { id: params.editorId } });
  const verb = params.accepted ? "accepted" : "declined";
  await prisma.notification.create({
    data: {
      userId: params.editorId,
      title: `Reviewer invitation ${verb}`,
      body:
        `${params.email} ${verb} your invitation to review for JIDA.` +
        (!params.accepted && params.reason ? ` Reason: ${params.reason}` : ""),
      kind: "GENERIC",
      visibleAt: new Date(),
    },
  });
  if (editor) {
    await sendMailSafe({
      to: editor.email,
      ...notificationEmail({
        heading: `Reviewer invitation ${verb}`,
        subject: `JIDA: invitation ${verb} — ${params.email}`,
        lines: [
          `${params.email} ${verb} your invitation to review for JIDA.`,
          ...(!params.accepted && params.reason ? [`Reason given: ${params.reason}`] : []),
          ...(params.accepted ? ["They can now be assigned manuscripts from the Peer Review page."] : []),
        ],
        actionUrl: `${editorDashboard()}`,
        actionLabel: "Open editor dashboard",
      }),
    });
  }
}

/** FR-R6 — approaching review deadline reminder. */
export async function notifyReviewerDeadlineApproaching(
  email: string,
  title: string,
  deadline: Date,
): Promise<void> {
  await sendMailSafe({
    to: email,
    ...notificationEmail({
      heading: "Review deadline approaching",
      subject: "JIDA: review deadline approaching",
      lines: [
        `Reminder: your review of "${title}" is due by ${deadline.toUTCString()}.`,
        "Please submit your evaluation before the deadline.",
      ],
      actionUrl: reviewerDashboard(),
      actionLabel: "Submit my review",
    }),
  });
}

export async function notifyEditorPendingDecision(
  editorEmail: string,
  title: string,
): Promise<void> {
  await sendMailSafe({
    to: editorEmail,
    ...notificationEmail({
      heading: "Pending editorial decision",
      subject: "JIDA: pending editorial decision",
      lines: [`All reviews are in for "${title}".`, "A decision is now required."],
      actionUrl: editorDashboard(),
      actionLabel: "Make a decision",
    }),
  });
}

/** Initial screening decision — notify the rest of the editorial team. */
export async function notifyEditorsOfDecision(
  title: string,
  decision: string,
  notes: string | undefined,
  decidingEditorId: string,
): Promise<void> {
  const editors = await prisma.user.findMany({
    where: { roles: { hasSome: storedRolesGranting(Role.EDITOR) }, id: { not: decidingEditorId } },
    select: { email: true },
  });
  const readable = decision.replace(/_/g, " ").toLowerCase();
  const mail = notificationEmail({
    heading: "Initial screening decision recorded",
    subject: `JIDA: initial screening — "${title}"`,
    lines: [
      `An initial screening decision was recorded for "${title}": ${readable}.`,
      ...(notes ? [notes] : []),
    ],
    actionUrl: editorDashboard(),
    actionLabel: "Open editor dashboard",
  });
  await Promise.all(editors.map((e) => sendMailSafe({ to: e.email, ...mail })));
}

/** Final screening decision — notify the reviewer(s) whose evaluation led to it, and the rest of the editorial team. */
export async function notifyReviewerOfFinalDecision(
  manuscriptId: string,
  title: string,
  decision: string,
  notes: string | undefined,
  decidingEditorId: string,
): Promise<void> {
  const [reviewers, editors] = await Promise.all([
    prisma.user.findMany({
      where: { reviewAssignments: { some: { manuscriptId } } },
      select: { email: true },
    }),
    prisma.user.findMany({
      where: { roles: { hasSome: storedRolesGranting(Role.EDITOR) }, id: { not: decidingEditorId } },
      select: { email: true },
    }),
  ]);
  const readable = decision.replace(/_/g, " ").toLowerCase();
  const mail = notificationEmail({
    heading: "Final screening decision recorded",
    subject: `JIDA: final decision — "${title}"`,
    lines: [
      `A final decision was recorded for "${title}", based on your evaluation: ${readable}.`,
      ...(notes ? [notes] : []),
    ],
    actionUrl: reviewerDashboard(),
    actionLabel: "Open my dashboard",
  });
  await Promise.all(
    [...reviewers, ...editors].map((u) => sendMailSafe({ to: u.email, ...mail })),
  );
}

export async function notifyAuthorPublished(
  email: string,
  title: string,
  slug: string,
): Promise<void> {
  const articleUrl = `${appUrl()}/archive/${slug}`;
  await sendMailSafe({
    to: email,
    ...notificationEmail({
      heading: "Your article is published",
      subject: "JIDA: your article is published",
      lines: [
        `Congratulations — your article "${title}" is now publicly available in the JIDA archive.`,
      ],
      actionUrl: articleUrl,
      actionLabel: "Read my published article",
    }),
  });
}

/**
 * Tells a self-registered author that the editorial team has decided on their
 * account.
 *
 * A rejection carries its reason: a refusal the person cannot understand reads
 * as a fault in the system, and they will simply register again.
 */
export async function notifyAuthorAccountDecision(params: {
  email: string;
  approved: boolean;
  reason?: string | null;
}): Promise<void> {
  await sendMailSafe({
    to: params.email,
    ...notificationEmail({
      heading: params.approved ? "Your JIDA account is approved" : "About your JIDA account",
      subject: params.approved
        ? "JIDA: your account is approved"
        : "JIDA: your account was not approved",
      lines: params.approved
        ? [
            "The editorial team has approved your author account.",
            "You can now sign in and submit a manuscript to JIDA.",
          ]
        : [
            "The editorial team has reviewed your author account and has not approved it for submissions.",
            ...(params.reason ? [`Reason: ${params.reason}`] : []),
            "If you believe this is a mistake, reply to this address and the editorial team will look again.",
          ],
      ...(params.approved
        ? { actionUrl: `${appUrl()}/login`, actionLabel: "Sign in to JIDA" }
        : {}),
    }),
  });
}
