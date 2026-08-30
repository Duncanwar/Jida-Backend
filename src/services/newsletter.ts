/**
 * Reader newsletter.
 *
 * A separate audience from the platform's users: readers have no account, are
 * not in the `User` table, and are only ever sent to the public archive. Three
 * things reach them — a confirmation when they subscribe, an editor
 * announcement (a call for papers), and word that an issue is published.
 *
 * Delivery is deliberately best-effort. A broadcast must never fail the action
 * that triggered it: an issue stays published, and an announcement stays
 * posted, even if the mail server is unreachable.
 */
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { sendMailSafe } from "./email.js";
import {
  newsletterAnnouncementEmail,
  newsletterIssueEmail,
  newsletterWelcomeEmail,
} from "./emailTemplates.js";

const appUrl = (): string => env.APP_URL.replace(/\/$/, "");

/** Readers are always sent to the archive — never to a dashboard. */
export const archiveUrl = (): string => `${appUrl()}/archive`;

export const unsubscribeUrl = (token: string): string =>
  `${appUrl()}/unsubscribe/${encodeURIComponent(token)}`;

/** Volume 7, Issue 1, 2026 — the wording readers see on the cover. */
export function issueLabel(issue: {
  volume: number;
  issueNumber: number;
  year: number;
  title?: string | null;
}): string {
  const base = `Volume ${issue.volume}, Issue ${issue.issueNumber}, ${issue.year}`;
  return issue.title?.trim() ? `${base} — ${issue.title.trim()}` : base;
}

export interface BroadcastResult {
  /** Addresses the send was attempted for. */
  recipients: number;
  /** How many the mail server accepted. */
  delivered: number;
}

/** Everyone still subscribed. Unsubscribed rows are kept but never mailed. */
async function activeSubscribers() {
  return prisma.newsletterSubscriber.findMany({
    where: { unsubscribedAt: null },
    select: { email: true, unsubscribeToken: true },
  });
}

/**
 * Sends one rendered mail per subscriber, each with its own unsubscribe link.
 *
 * Sequential on purpose: this list is small, and a burst of parallel
 * connections is what gets a new sending domain rate-limited or blocked.
 */
async function broadcast(
  render: (unsubUrl: string) => { subject: string; text: string; html: string },
): Promise<BroadcastResult> {
  const subscribers = await activeSubscribers();
  let delivered = 0;
  for (const s of subscribers) {
    const mail = render(unsubscribeUrl(s.unsubscribeToken));
    const ok = await sendMailSafe({ to: s.email, ...mail });
    if (ok) delivered += 1;
  }
  return { recipients: subscribers.length, delivered };
}

/** Confirms a new subscription. Sent to one address, immediately. */
export async function sendNewsletterWelcome(
  email: string,
  token: string,
): Promise<boolean> {
  return sendMailSafe({
    to: email,
    ...newsletterWelcomeEmail({
      archiveUrl: archiveUrl(),
      unsubscribeUrl: unsubscribeUrl(token),
    }),
  });
}

/** An editor announcement — typically a call for papers. */
export async function broadcastAnnouncement(params: {
  title: string;
  body: string;
}): Promise<BroadcastResult> {
  return broadcast((unsub) =>
    newsletterAnnouncementEmail({
      title: params.title,
      body: params.body,
      archiveUrl: archiveUrl(),
      unsubscribeUrl: unsub,
    }),
  );
}

/** A published issue, with the number of articles currently in it. */
export async function broadcastIssue(issueId: string): Promise<BroadcastResult> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: { _count: { select: { publications: true } } },
  });
  if (!issue) return { recipients: 0, delivered: 0 };

  return broadcast((unsub) =>
    newsletterIssueEmail({
      issueLabel: issueLabel(issue),
      articleCount: issue._count.publications,
      archiveUrl: archiveUrl(),
      unsubscribeUrl: unsub,
    }),
  );
}
