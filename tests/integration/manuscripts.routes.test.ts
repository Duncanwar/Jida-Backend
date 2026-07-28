import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@prisma/client";
import { prismaMock, resetPrismaMock } from "../helpers/prismaMock.js";
import { signAccessToken } from "../../src/utils/jwt.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../src/services/email.js", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendMailSafe: vi.fn().mockResolvedValue(true),
  verifyEmailTransport: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/notifications.js", () => ({
  notifyAuthorStatus: vi.fn().mockResolvedValue(undefined),
  notifyEditorsNewSubmission: vi.fn().mockResolvedValue(undefined),
  notifyAuthorSubmissionReceived: vi.fn().mockResolvedValue(true),
}));

const { createApp } = await import("../../src/app.js");
const notifications = await import("../../src/services/notifications.js");
const app = createApp();

const authorToken = signAccessToken("author-1", Role.AUTHOR);
const reviewerToken = signAccessToken("reviewer-1", Role.REVIEWER);

beforeEach(() => resetPrismaMock());

describe("manuscripts route protection", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/manuscripts");
    expect(res.status).toBe(401);
  });

  it("rejects non-author roles with 403", async () => {
    const res = await request(app)
      .get("/api/manuscripts")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/manuscripts", () => {
  it("lists only the authenticated author's manuscripts", async () => {
    prismaMock.manuscript.findMany.mockResolvedValue([
      { id: "m1", title: "Paper A", authorId: "author-1" },
    ]);

    const res = await request(app)
      .get("/api/manuscripts")
      .set("Authorization", `Bearer ${authorToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const arg = prismaMock.manuscript.findMany.mock.calls[0][0];
    expect(arg.where.authorId).toBe("author-1");
  });

  it("applies a search filter over title and abstract", async () => {
    prismaMock.manuscript.findMany.mockResolvedValue([]);
    await request(app)
      .get("/api/manuscripts")
      .query({ q: "quantum" })
      .set("Authorization", `Bearer ${authorToken}`);
    const arg = prismaMock.manuscript.findMany.mock.calls[0][0];
    expect(arg.where.OR).toBeDefined();
  });
});

describe("GET /api/manuscripts/:id", () => {
  it("returns 404 for a manuscript that is not the author's", async () => {
    prismaMock.manuscript.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/manuscripts/other-authors-id")
      .set("Authorization", `Bearer ${authorToken}`);
    expect(res.status).toBe(404);
  });

  it("returns the manuscript with its files", async () => {
    prismaMock.manuscript.findFirst.mockResolvedValue({
      id: "m1",
      title: "Paper A",
      files: [{ id: "f1", versionLabel: 1 }],
    });
    const res = await request(app)
      .get("/api/manuscripts/m1")
      .set("Authorization", `Bearer ${authorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
  });
});

describe("POST /api/manuscripts (submission)", () => {
  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/manuscripts")
      .set("Authorization", `Bearer ${authorToken}`)
      .field("title", "Only a title");
    expect(res.status).toBe(400);
  });

  it("rejects non-PDF/DOCX uploads", async () => {
    const res = await request(app)
      .post("/api/manuscripts")
      .set("Authorization", `Bearer ${authorToken}`)
      .field("title", "T")
      .field("abstract", "A")
      .field("references", "R")
      .attach("file", Buffer.from("plain text"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(500); // multer fileFilter error surfaces via error handler
    expect(res.body.error).toMatch(/only pdf and docx/i);
  });

  it("returns 403 when submissions are closed", async () => {
    prismaMock.journalSettings.upsert.mockResolvedValue({
      id: 1,
      openForSubmissions: false,
      submissionDeadline: null,
    });
    const res = await request(app)
      .post("/api/manuscripts")
      .set("Authorization", `Bearer ${authorToken}`)
      .field("title", "T")
      .field("abstract", "A")
      .field("references", "R")
      .attach("file", Buffer.from("%PDF-1.4 fake"), {
        filename: "paper.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/closed/i);
  });

  function mockSuccessfulSubmission() {
    prismaMock.journalSettings.upsert.mockResolvedValue({
      id: 1,
      openForSubmissions: true,
      submissionDeadline: null,
    });
    prismaMock.manuscript.create.mockResolvedValue({
      id: "m-new",
      title: "T",
      createdAt: new Date("2026-07-27T10:00:00Z"),
      files: [
        {
          id: "f1",
          versionLabel: 1,
          isLatest: true,
          originalName: "paper.pdf",
          sizeBytes: 13,
        },
      ],
    });
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      email: "author@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  }

  function submit() {
    return request(app)
      .post("/api/manuscripts")
      .set("Authorization", `Bearer ${authorToken}`)
      .field("title", "T")
      .field("abstract", "A")
      .field("keywords", "ai, ml; nlp")
      .field("references", "R")
      .attach("file", Buffer.from("%PDF-1.4 fake"), {
        filename: "paper.pdf",
        contentType: "application/pdf",
      });
  }

  it("creates a manuscript with its first file version and notifies editors", async () => {
    mockSuccessfulSubmission();

    const res = await submit();

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("m-new");
    const arg = prismaMock.manuscript.create.mock.calls[0][0];
    expect(arg.data.authorId).toBe("author-1");
    expect(arg.data.keywords).toEqual(["ai", "ml", "nlp"]);
    expect(arg.data.files.create.versionLabel).toBe(1);
    expect(notifications.notifyEditorsNewSubmission).toHaveBeenCalledWith("T", "Ada Lovelace");
  });

  // Requirement 2 — the author must get the upload in their own inbox.
  it("emails the author a receipt for their submission", async () => {
    mockSuccessfulSubmission();

    await submit();

    expect(notifications.notifyAuthorSubmissionReceived).toHaveBeenCalledOnce();
    const receipt = vi.mocked(notifications.notifyAuthorSubmissionReceived).mock.calls[0][0];
    expect(receipt.email).toBe("author@example.com");
    expect(receipt.title).toBe("T");
    expect(receipt.manuscriptId).toBe("m-new");
    expect(receipt.fileName).toBe("paper.pdf");
    expect(receipt.isRevision).toBeFalsy();
  });

  it("still returns 201 when the receipt email fails — the upload already succeeded", async () => {
    mockSuccessfulSubmission();
    vi.mocked(notifications.notifyAuthorSubmissionReceived).mockResolvedValueOnce(false);

    const res = await submit();

    expect(res.status).toBe(201);
  });
});
