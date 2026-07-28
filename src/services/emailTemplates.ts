/**
 * Shared HTML email layout + templates.
 *
 * Everything is inline-styled and table-free-ish on purpose: Gmail, Outlook and
 * Apple Mail strip <style> blocks and external CSS, so inline attributes are the
 * only reliable way to control rendering. Every template also returns a plain
 * text alternative — clients that block HTML (and spam filters) expect one.
 */

const BRAND = "#0f3d5c";
const BRAND_LIGHT = "#e8f1f7";
const TEXT = "#1f2933";
const MUTED = "#6b7785";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wraps body markup in the shared JIDA shell. `body` must already be escaped. */
function layout(options: { heading: string; body: string; footerNote?: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.heading)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e3e8ee;">
            <tr>
              <td style="background-color:${BRAND};padding:20px 28px;">
                <span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background-color:#ffffff;color:${BRAND};border-radius:8px;font-weight:700;font-size:18px;">J</span>
                <span style="color:#ffffff;font-size:17px;font-weight:600;margin-left:10px;vertical-align:middle;">JIDA</span>
                <div style="color:${BRAND_LIGHT};font-size:12px;margin-top:6px;">Journal of Inter-Discourse Academia</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${TEXT};">${escapeHtml(options.heading)}</h1>
                ${options.body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px;border-top:1px solid #eef1f5;color:${MUTED};font-size:12px;line-height:1.6;">
                ${options.footerNote ?? "This is an automated message from the JIDA submission system — please do not reply."}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT};">${text}</p>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;">
    <tr>
      <td style="background-color:${BRAND};border-radius:8px;">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function fallbackLink(href: string): string {
  return `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:${MUTED};">
    If the button does not work, copy this link into your browser:<br />
    <span style="color:${BRAND};word-break:break-all;">${escapeHtml(href)}</span>
  </p>`;
}

/** Key/value detail block used by submission receipts. */
function detailRows(rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([k, v]) => `<tr>
        <td style="padding:7px 0;font-size:13px;color:${MUTED};width:150px;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:7px 0;font-size:14px;color:${TEXT};font-weight:500;">${escapeHtml(v)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e3e8ee;border-radius:10px;padding:8px 16px;margin:0 0 18px;">${body}</table>`;
}

// ─── Templates ───────────────────────────────────────────────────────────────

/** FR-AUTH-1 — confirm ownership of the email address used at registration. */
export function verificationEmail(params: {
  name?: string | null;
  verifyUrl: string;
  ttlHours: number;
}): RenderedEmail {
  const greeting = params.name ? `Hello ${params.name},` : "Hello,";
  return {
    subject: "Verify your JIDA email address",
    text: [
      greeting,
      "",
      "Thank you for creating a JIDA account. Please confirm your email address to activate it:",
      "",
      params.verifyUrl,
      "",
      `This link expires in ${params.ttlHours} hour(s) and can be used once.`,
      "You will not be able to sign in until your address is verified.",
      "",
      "If you did not create this account, you can safely ignore this email.",
      "",
      "— JIDA, Journal of Inter-Discourse Academia",
    ].join("\n"),
    html: layout({
      heading: "Verify your email address",
      body: [
        paragraph(escapeHtml(greeting)),
        paragraph(
          "Thank you for creating a JIDA account. Confirm your email address to activate it and continue.",
        ),
        button(params.verifyUrl, "Verify my email"),
        fallbackLink(params.verifyUrl),
        paragraph(
          `<strong>This link expires in ${params.ttlHours} hour(s)</strong> and can be used only once. You will not be able to sign in until your address is verified.`,
        ),
        paragraph(
          `<span style="color:${MUTED};font-size:13px;">If you did not create this account, no action is needed — the account stays inactive and is removed automatically.</span>`,
        ),
      ].join(""),
    }),
  };
}

/** Sent once verification succeeds. */
export function welcomeEmail(params: { name?: string | null; loginUrl: string; role: string }): RenderedEmail {
  const greeting = params.name ? `Hello ${params.name},` : "Hello,";
  return {
    subject: "Your JIDA account is active",
    text: [
      greeting,
      "",
      `Your email address has been verified and your JIDA account (${params.role.toLowerCase()}) is now active.`,
      "",
      `Sign in here: ${params.loginUrl}`,
      "",
      "— JIDA, Journal of Inter-Discourse Academia",
    ].join("\n"),
    html: layout({
      heading: "Your account is active",
      body: [
        paragraph(escapeHtml(greeting)),
        paragraph(
          `Your email address has been verified and your JIDA account (<strong>${escapeHtml(params.role.toLowerCase())}</strong>) is now active.`,
        ),
        button(params.loginUrl, "Sign in to JIDA"),
      ].join(""),
    }),
  };
}

/**
 * FR-A3 — the author's own receipt for a submission or a revision upload.
 * This is the copy that lands in the author's inbox, separate from the
 * notification the editorial team receives.
 */
export function submissionReceiptEmail(params: {
  name?: string | null;
  title: string;
  manuscriptId: string;
  fileName: string;
  fileSizeBytes: number;
  submittedAt: Date;
  dashboardUrl: string;
  versionLabel?: number;
  isRevision?: boolean;
}): RenderedEmail {
  const greeting = params.name ? `Hello ${params.name},` : "Hello,";
  const kind = params.isRevision ? "revision" : "submission";
  const sizeMb = (params.fileSizeBytes / (1024 * 1024)).toFixed(2);
  const when = params.submittedAt.toUTCString();

  const rows: Array<[string, string]> = [
    ["Manuscript", params.title],
    ["Reference ID", params.manuscriptId],
    ["File", `${params.fileName} (${sizeMb} MB)`],
    ...(params.versionLabel ? ([["Version", `v${params.versionLabel}`]] as Array<[string, string]>) : []),
    ["Received", when],
  ];

  const nextSteps = params.isRevision
    ? [
        "The handling editor is notified of your revision.",
        "Reviewers may be asked to re-evaluate the updated manuscript.",
        "You will receive an email at every status change.",
      ]
    : [
        "An editor performs an initial check of scope and completeness.",
        "If it passes, reviewers are assigned and given a deadline.",
        "You will receive an email at every status change — no need to check back.",
      ];

  return {
    subject: params.isRevision
      ? `JIDA: revision received — "${params.title}"`
      : `JIDA: submission received — "${params.title}"`,
    text: [
      greeting,
      "",
      `We have received your ${kind}. This email is your confirmation of record.`,
      "",
      ...rows.map(([k, v]) => `${k}: ${v}`),
      "",
      "What happens next:",
      ...nextSteps.map((s, i) => `  ${i + 1}. ${s}`),
      "",
      `Track progress on your dashboard: ${params.dashboardUrl}`,
      "",
      "— JIDA, Journal of Inter-Discourse Academia",
    ].join("\n"),
    html: layout({
      heading: params.isRevision ? "Revision received" : "Submission received",
      body: [
        paragraph(escapeHtml(greeting)),
        paragraph(
          `We have received your ${escapeHtml(kind)}. Keep this email — it is your confirmation of record.`,
        ),
        detailRows(rows),
        `<p style="margin:0 0 8px;font-size:15px;font-weight:600;color:${TEXT};">What happens next</p>
         <ol style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.7;color:${TEXT};">
           ${nextSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
         </ol>`,
        button(params.dashboardUrl, "View my submissions"),
      ].join(""),
    }),
  };
}

/** Password reset link (FR-AUTH-3). */
export function passwordResetEmail(params: {
  name?: string | null;
  resetUrl: string;
  token: string;
  ttlMinutes: number;
}): RenderedEmail {
  const greeting = params.name ? `Hello ${params.name},` : "Hello,";
  return {
    subject: "Reset your JIDA password",
    text: [
      greeting,
      "",
      "We received a request to reset your JIDA password.",
      "",
      params.resetUrl,
      "",
      `This link expires in ${params.ttlMinutes} minutes and can be used once.`,
      "If you did not request this, ignore this email — your password is unchanged.",
      "",
      "— JIDA, Journal of Inter-Discourse Academia",
    ].join("\n"),
    html: layout({
      heading: "Reset your password",
      body: [
        paragraph(escapeHtml(greeting)),
        paragraph("We received a request to reset your JIDA password."),
        button(params.resetUrl, "Choose a new password"),
        fallbackLink(params.resetUrl),
        paragraph(
          `This link expires in <strong>${params.ttlMinutes} minutes</strong> and can be used once. If you did not request it, ignore this email — your password is unchanged.`,
        ),
      ].join(""),
    }),
  };
}

/** Generic notification body used by the editorial workflow emails. */
export function notificationEmail(params: {
  heading: string;
  subject: string;
  lines: string[];
  actionUrl?: string;
  actionLabel?: string;
}): RenderedEmail {
  return {
    subject: params.subject,
    text: [...params.lines, "", ...(params.actionUrl ? [params.actionUrl, ""] : []), "— JIDA"].join("\n"),
    html: layout({
      heading: params.heading,
      body: [
        ...params.lines.map((l) => paragraph(escapeHtml(l))),
        ...(params.actionUrl ? [button(params.actionUrl, params.actionLabel ?? "Open JIDA")] : []),
      ].join(""),
    }),
  };
}
