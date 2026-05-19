import { prisma } from "../lib/prisma.js";
import { sendMail } from "./email.js";
import type { ManuscriptStatus } from "@prisma/client";

export async function notifyEditorsNewSubmission(title: string): Promise<void> {
  const editors = await prisma.user.findMany({
    where: { role: "EDITOR" },
    select: { email: true },
  });
  await Promise.all(
    editors.map((e) =>
      sendMail({
        to: e.email,
        subject: "JIDA: new manuscript submission",
        text: `A new manuscript was submitted: "${title}". Please log in to the editor dashboard to review it.`,
      }),
    ),
  );
}

export async function notifyAuthorStatus(email: string, title: string, status: ManuscriptStatus): Promise<void> {
  await sendMail({
    to: email,
    subject: `JIDA: manuscript status update — ${status}`,
    text: `Your manuscript "${title}" status is now: ${status}.`,
  });
}

export async function notifyReviewerAssigned(
  email: string,
  title: string,
  deadline: Date,
): Promise<void> {
  await sendMail({
    to: email,
    subject: "JIDA: new review assignment",
    text: `You have been assigned to review "${title}". Please complete your review by ${deadline.toISOString()}.`,
  });
}

export async function notifyEditorPendingDecision(editorEmail: string, title: string): Promise<void> {
  await sendMail({
    to: editorEmail,
    subject: "JIDA: pending editorial decision",
    text: `Reviews are in for "${title}". Please log in to make a decision.`,
  });
}

export async function notifyAuthorPublished(email: string, title: string, slug: string): Promise<void> {
  await sendMail({
    to: email,
    subject: "JIDA: your article is published",
    text: `Your article "${title}" is now publicly available (slug: ${slug}).`,
  });
}
