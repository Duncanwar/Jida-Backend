import { prisma } from "../lib/prisma.js";
import { sendMailSafe } from "./email.js";
import { notificationEmail, submissionReceiptEmail } from "./emailTemplates.js";
import { env } from "../config/env.js";
import type { ManuscriptStatus } from "@prisma/client";

const appUrl = (): string => env.APP_URL.replace(/\/$/, "");

const authorDashboard = (): string => `${appUrl()}/author`;
const editorDashboard = (): string => `${appUrl()}/editor`;
const reviewerDashboard = (): string => `${appUrl()}/reviewer`;

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
    where: { role: "EDITOR" },
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

export async function notifyReviewerAssigned(
  email: string,
  title: string,
  deadline: Date,
): Promise<void> {
  await sendMailSafe({
    to: email,
    ...notificationEmail({
      heading: "New review assignment",
      subject: "JIDA: new review assignment",
      lines: [
        `You have been assigned to review "${title}".`,
        `Please submit your evaluation by ${deadline.toUTCString()}.`,
      ],
      actionUrl: reviewerDashboard(),
      actionLabel: "Open my assignments",
    }),
  });
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
