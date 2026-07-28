import { describe, expect, it } from "vitest";
import {
  submissionReceiptEmail,
  verificationEmail,
} from "../../src/services/emailTemplates.js";

describe("verificationEmail", () => {
  const mail = verificationEmail({
    name: "Ada Lovelace",
    verifyUrl: "https://jida.example/verify-email?token=abc123",
    ttlHours: 24,
  });

  it("puts the link in both the HTML and plain-text parts", () => {
    // Clients that block HTML still need a usable link, and a missing text part
    // is a strong spam signal.
    expect(mail.text).toContain("https://jida.example/verify-email?token=abc123");
    expect(mail.html).toContain("https://jida.example/verify-email?token=abc123");
  });

  it("states the expiry so the user knows the link is time-boxed", () => {
    expect(mail.text).toMatch(/24 hour/i);
    expect(mail.html).toMatch(/24 hour/i);
  });

  it("escapes user-controlled content to prevent HTML injection", () => {
    const hostile = verificationEmail({
      name: '<script>alert("xss")</script>',
      verifyUrl: "https://jida.example/verify-email?token=x",
      ttlHours: 24,
    });
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&lt;script&gt;");
  });
});

describe("submissionReceiptEmail", () => {
  const mail = submissionReceiptEmail({
    name: "Ada Lovelace",
    title: "On Analytical Engines",
    manuscriptId: "m-123",
    fileName: "engines.pdf",
    fileSizeBytes: 2 * 1024 * 1024,
    submittedAt: new Date("2026-07-27T10:00:00Z"),
    dashboardUrl: "https://jida.example/author",
    versionLabel: 1,
  });

  it("includes the details that make it a usable receipt", () => {
    expect(mail.subject).toContain("On Analytical Engines");
    expect(mail.text).toContain("m-123");
    expect(mail.text).toContain("engines.pdf");
    expect(mail.text).toContain("2.00 MB");
    expect(mail.html).toContain("On Analytical Engines");
  });

  it("explains what happens next", () => {
    expect(mail.text).toMatch(/what happens next/i);
    expect(mail.text).toMatch(/reviewers are assigned/i);
  });

  it("uses revision wording when the upload is a revision", () => {
    const revision = submissionReceiptEmail({
      title: "On Analytical Engines",
      manuscriptId: "m-123",
      fileName: "engines-v2.pdf",
      fileSizeBytes: 1024,
      submittedAt: new Date("2026-07-27T10:00:00Z"),
      dashboardUrl: "https://jida.example/author",
      versionLabel: 2,
      isRevision: true,
    });
    expect(revision.subject).toMatch(/revision received/i);
    expect(revision.text).toContain("v2");
  });

  it("escapes the manuscript title", () => {
    const hostile = submissionReceiptEmail({
      title: '<img src=x onerror="alert(1)">',
      manuscriptId: "m-1",
      fileName: "a.pdf",
      fileSizeBytes: 1,
      submittedAt: new Date(),
      dashboardUrl: "https://jida.example/author",
    });
    expect(hostile.html).not.toContain("<img src=x");
    expect(hostile.html).toContain("&lt;img");
  });
});
