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
  notifyAuthorPublished: vi.fn().mockResolvedValue(undefined),
  notifyAuthorEditedFile: vi.fn().mockResolvedValue(undefined),
}));

const { createApp } = await import("../../src/app.js");
const app = createApp();

const editorToken = signAccessToken("editor-1", Role.EDITOR);
const authorToken = signAccessToken("author-1", Role.AUTHOR);

beforeEach(() => resetPrismaMock());

describe("PATCH /api/editor/publications/:id/scholar", () => {
  function mockPublication(file: { originalName: string; mimeType: string } | null) {
    prismaMock.publication.findUnique.mockResolvedValue({
      id: "p1",
      scholarReady: false,
      issue: { volume: 7, issueNumber: 1, year: 2026 },
      manuscript: {
        title: "Effects of Teamwork",
        abstract: "A".repeat(400),
        keywords: ["teamwork", "performance", "education"],
        references: Array.from({ length: 18 }, (_, i) => `Ref ${i}`).join("\n"),
        author: { firstName: "Darren", lastName: "Iraguha", affiliation: "AUCA, Kigali, Rwanda" },
        coAuthors: [],
        files: file ? [file] : [],
      },
    });
  }

  it("refuses to flag an article whose full text is not a PDF", async () => {
    mockPublication({ originalName: "paper.docx", mimeType: "application/msword" });

    const res = await request(app)
      .patch("/api/editor/publications/p1/scholar")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ scholarReady: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SCHOLAR_NOT_READY");
    expect(res.body.blockers.map((b: { id: string }) => b.id)).toContain("file-format");
    // Crucially, the flag is not set — otherwise the page would emit citation
    // tags pointing at something Scholar cannot index.
    expect(prismaMock.publication.update).not.toHaveBeenCalled();
  });

  it("flags an article that meets the requirements", async () => {
    mockPublication({ originalName: "paper.pdf", mimeType: "application/pdf" });
    prismaMock.publication.update.mockResolvedValue({ id: "p1", scholarReady: true });

    const res = await request(app)
      .patch("/api/editor/publications/p1/scholar")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ scholarReady: true });

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(prismaMock.publication.update.mock.calls[0][0].data.scholarReady).toBe(true);
  });

  it("always allows un-flagging, even when the article would fail the checks", async () => {
    mockPublication({ originalName: "paper.docx", mimeType: "application/msword" });
    prismaMock.publication.update.mockResolvedValue({ id: "p1", scholarReady: false });

    const res = await request(app)
      .patch("/api/editor/publications/p1/scholar")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ scholarReady: false });

    expect(res.status).toBe(200);
    expect(prismaMock.publication.update).toHaveBeenCalled();
  });

  it("reports readiness without changing anything", async () => {
    mockPublication({ originalName: "paper.pdf", mimeType: "application/pdf" });

    const res = await request(app)
      .get("/api/editor/publications/p1/scholar-check")
      .set("Authorization", `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(prismaMock.publication.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/users/:id/roles", () => {
  const adminToken = signAccessToken("admin-1", Role.ADMIN, true, [Role.ADMIN]);

  it("promotes a sitting editor to chief editor", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "editor-1", email: "e@example.com" });
    prismaMock.user.update.mockResolvedValue({
      id: "editor-1",
      email: "e@example.com",
      role: Role.CHIEF_EDITOR,
      roles: [Role.CHIEF_EDITOR],
      firstName: null,
      lastName: null,
      affiliation: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await request(app)
      .patch("/api/admin/users/editor-1/roles")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: Role.CHIEF_EDITOR });

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([Role.CHIEF_EDITOR]);
    expect(prismaMock.user.update.mock.calls[0][0].data.roles).toEqual([Role.CHIEF_EDITOR]);
  });

  it("keeps the primary role inside the granted set", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "u1", email: "u@example.com" });
    prismaMock.user.update.mockResolvedValue({
      id: "u1", email: "u@example.com", role: Role.AUTHOR,
      roles: [Role.AUTHOR, Role.REVIEWER], firstName: null, lastName: null,
      affiliation: null, createdAt: new Date(),
    });

    await request(app)
      .patch("/api/admin/users/u1/roles")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: Role.AUTHOR, roles: [Role.REVIEWER] });

    expect(prismaMock.user.update.mock.calls[0][0].data.roles).toEqual(
      expect.arrayContaining([Role.AUTHOR, Role.REVIEWER]),
    );
  });

  it("stops an admin from removing their own admin role", async () => {
    const res = await request(app)
      .patch("/api/admin/users/admin-1/roles")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: Role.AUTHOR });

    expect(res.status).toBe(400);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("rejects a non-admin", async () => {
    const res = await request(app)
      .patch("/api/admin/users/u1/roles")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ role: Role.AUTHOR });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/editor/submissions", () => {
  it("rejects an author with 403", async () => {
    const res = await request(app)
      .get("/api/editor/submissions")
      .set("Authorization", `Bearer ${authorToken}`);
    expect(res.status).toBe(403);
  });

  function mockSubmission() {
    prismaMock.manuscript.findMany.mockResolvedValue([
      {
        id: "m1",
        title: "Paper A",
        status: "UNDER_REVIEW",
        createdAt: new Date("2026-07-20T09:00:00Z"),
        author: { id: "author-1", email: "author@example.com", firstName: "Ada", lastName: "Lovelace" },
        files: [],
        coAuthors: [
          {
            fullName: "Charles Babbage",
            email: "cb@example.com",
            affiliation: "AUCA",
            isCorresponding: true,
          },
        ],
        assignments: [
          {
            id: "a1",
            manuscriptId: "m1",
            deadline: new Date("2026-09-01T00:00:00Z"),
            progress: "FINISHED_REVIEW",
            reviewer: {
              id: "reviewer-1",
              email: "rev@example.com",
              firstName: "Alan",
              lastName: "Turing",
            },
            review: {
              id: "r1",
              recommendation: "MINOR_REVISION",
              commentsToAuthor: "Tighten the methodology section.",
              specificSuggestions: "Expand the literature review to cover 2024-2026.",
              commentsToEditor: "Borderline — the stats are shaky.",
              ratingTitle: "GOOD",
              ratingAbstract: "MODERATE",
              ratingLiterature: "POOR",
              ratingMethods: "GOOD",
              ratingConclusions: "MODERATE",
              ratingReferences: "POOR",
              ratingStructure: "EXCELLENT",
              createdAt: new Date("2026-08-01T10:00:00Z"),
              attachmentStoredName: null,
              attachmentOriginalName: null,
              authorFeedback: { rating: 4, comment: "Helpful and specific." },
            },
          },
        ],
        decisions: [
          {
            decision: "REQUEST_REVISION",
            notes: "Please address the reviewer.",
            createdAt: new Date("2026-08-02T10:00:00Z"),
            editor: { firstName: "Grace", lastName: "Hopper", email: "editor@example.com" },
          },
        ],
      },
    ]);
    return request(app)
      .get("/api/editor/submissions")
      .set("Authorization", `Bearer ${editorToken}`);
  }

  it("returns both sets of reviewer comments — editors see the confidential ones", async () => {
    const res = await mockSubmission();
    expect(res.status).toBe(200);
    const assignment = res.body[0].assignments[0];
    expect(assignment.commentsToAuthor).toBe("Tighten the methodology section.");
    expect(assignment.commentsToEditor).toBe("Borderline — the stats are shaky.");
    expect(assignment.reviewedAt).toBeTruthy();
  });

  it("gives the editor the whole review form, ratings included", async () => {
    const res = await mockSubmission();
    const { review } = res.body[0].assignments[0];
    expect(review.recommendationLabel).toBe("Accepted, minor revisions needed.");
    expect(review.specificSuggestions).toBe("Expand the literature review to cover 2024-2026.");
    expect(review.commentsToEditor).toBe("Borderline — the stats are shaky.");
    // All seven assessment items, in form order, each carrying its label.
    expect(review.assessment).toHaveLength(7);
    expect(review.assessment[0]).toMatchObject({ key: "ratingTitle", rating: "GOOD" });
    expect(review.assessment[6]).toMatchObject({ key: "ratingStructure", rating: "EXCELLENT" });
  });

  it("shows the editor the author's feedback on the reviewer's work", async () => {
    const res = await mockSubmission();
    expect(res.body[0].assignments[0].authorFeedback).toEqual({
      rating: 4,
      comment: "Helpful and specific.",
    });
  });

  it("includes co-authors on the submission", async () => {
    const res = await mockSubmission();
    expect(res.body[0].coAuthors).toEqual([
      {
        fullName: "Charles Babbage",
        email: "cb@example.com",
        affiliation: "AUCA",
        isCorresponding: true,
      },
    ]);
  });

  it("includes editorial decisions with the editor who recorded them", async () => {
    const res = await mockSubmission();
    expect(res.body[0].decisions).toHaveLength(1);
    expect(res.body[0].decisions[0]).toMatchObject({
      decision: "REQUEST_REVISION",
      notes: "Please address the reviewer.",
      editorName: "Grace Hopper",
    });
  });

  it("falls back to the editor's email when they have no name on file", async () => {
    prismaMock.manuscript.findMany.mockResolvedValue([
      {
        id: "m1",
        title: "Paper A",
        status: "SUBMITTED",
        createdAt: new Date("2026-07-21T09:00:00Z"),
        author: { id: "author-1", email: "author@example.com", firstName: null, lastName: null },
        files: [],
        coAuthors: [],
        assignments: [],
        decisions: [
          {
            decision: "ACCEPT",
            notes: null,
            createdAt: new Date("2026-08-02T10:00:00Z"),
            editor: { firstName: null, lastName: null, email: "editor@example.com" },
          },
        ],
      },
    ]);
    const res = await request(app)
      .get("/api/editor/submissions")
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.body[0].decisions[0].editorName).toBe("editor@example.com");
  });
});
