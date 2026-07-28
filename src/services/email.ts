import nodemailer from "nodemailer";
import { env } from "../config/env.js";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE ?? false,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
    // Reuse one authenticated connection across a burst of sends (e.g. notifying
    // every editor) instead of re-handshaking per message.
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

/**
 * Verifies SMTP credentials at boot so a misconfigured mail server surfaces in
 * the startup logs rather than silently swallowing verification emails.
 * Never throws — a dead mail server must not stop the API from serving.
 */
export async function verifyEmailTransport(): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) {
    console.warn(
      "[email] SMTP_HOST is not set — emails are logged to the console instead of sent. Configure SMTP before going to production.",
    );
    return false;
  }
  try {
    await tx.verify();
    console.info(`[email] SMTP ready (${env.SMTP_HOST}:${env.SMTP_PORT ?? 587})`);
    return true;
  } catch (err) {
    console.error("[email] SMTP verification failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends an email, retrying transient SMTP failures with exponential backoff.
 *
 * Throws only after every attempt fails. Callers that must not fail the request
 * because of a mail outage should use {@link sendMailSafe}.
 */
export async function sendMail(options: MailOptions): Promise<void> {
  const tx = getTransporter();
  const from = env.SMTP_FROM ?? "JIDA <noreply@localhost>";

  if (!tx) {
    // Development / test: log instead of sending so the flows stay exercisable
    // without an SMTP server. Verification links are printed in full.
    console.info("[email:stub]", {
      from,
      to: options.to,
      subject: options.subject,
      text: options.text,
    });
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await tx.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });
      return;
    } catch (err) {
      lastError = err;
      // 5xx SMTP replies are permanent (bad address, blocked sender) — retrying
      // only wastes time and hurts sender reputation.
      const code = (err as { responseCode?: number }).responseCode;
      if (typeof code === "number" && code >= 500 && code < 600) break;
      if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to send email");
}

/**
 * Fire-and-forget variant: logs failures instead of propagating them.
 *
 * Used for notifications where the user's action has already succeeded and
 * must not be rolled back because the mail server happens to be unreachable.
 */
export async function sendMailSafe(options: MailOptions): Promise<boolean> {
  try {
    await sendMail(options);
    return true;
  } catch (err) {
    console.error(
      `[email] delivery failed to=${options.to} subject="${options.subject}":`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
