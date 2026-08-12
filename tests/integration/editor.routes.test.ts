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
        author: { id: "author-1", email: "author@example.com", firstName: "Ada", lastName: "Lovelace" },
        files: [],
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
              commentsToEditor: "Borderline — the stats are shaky.",
              createdAt: new Date("2026-08-01T10:00:00Z"),
              attachmentStoredName: null,
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
        author: { id: "author-1", email: "author@example.com", firstName: null, lastName: null },
        files: [],
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
