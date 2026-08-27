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
  notifyReviewerInvitation: vi.fn().mockResolvedValue(true),
  notifyReviewerAssigned: vi.fn().mockResolvedValue(undefined),
  notifyEditorAssignmentResponse: vi.fn().mockResolvedValue(undefined),
  notifyEditorPendingDecision: vi.fn().mockResolvedValue(undefined),
}));

const { createApp } = await import("../../src/app.js");
const notifications = await import("../../src/services/notifications.js");
const app = createApp();

const editorToken = signAccessToken("editor-1", Role.EDITOR);

beforeEach(() => {
  resetPrismaMock();
  vi.mocked(notifications.notifyReviewerInvitation).mockClear();
});

describe("POST /api/editor/manuscripts/:id/assign-reviewers — 2-reviewer cap", () => {
  it("refuses an assignment that would give a manuscript a third reviewer", async () => {
    prismaMock.manuscript.findUnique.mockResolvedValue({ id: "m1", title: "Paper", authorId: "a1" });
    prismaMock.user.findMany.mockResolvedValue([{ id: "r3" }]);
    prismaMock.reviewAssignment.findMany.mockResolvedValue([
      { reviewerId: "r1" },
      { reviewerId: "r2" },
    ]);

    const res = await request(app)
      .post("/api/editor/manuscripts/m1/assign-reviewers")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ assignments: [{ reviewerId: "11111111-1111-1111-1111-111111111111", deadline: "2026-09-30" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 2 reviewers/i);
    expect(prismaMock.reviewAssignment.upsert).not.toHaveBeenCalled();
  });
});

describe("POST /api/editor/reviewer-invitations", () => {
  it("creates a pending invitation and emails it", async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      id: "editor-1",
      email: "ed@jida.test",
      firstName: "Ed",
      lastName: "Itor",
    });
    prismaMock.reviewerInvitation.create.mockResolvedValue({
      id: "inv-1",
      email: "prospect@example.com",
      status: "PENDING",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });

    const res = await request(app)
      .post("/api/editor/reviewer-invitations")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ email: "prospect@example.com", message: "Hi — would you review for us?" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    const createArg = prismaMock.reviewerInvitation.create.mock.calls[0][0].data;
    expect(createArg.email).toBe("prospect@example.com");
    expect(typeof createArg.tokenHash).toBe("string");
    expect(notifications.notifyReviewerInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ email: "prospect@example.com", inviterName: "Ed Itor" }),
    );
  });
});
