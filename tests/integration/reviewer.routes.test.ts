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
  clearAssignmentActionNotifications: vi.fn().mockResolvedValue(undefined),
  notifyEditorAssignmentResponse: vi.fn().mockResolvedValue(undefined),
  notifyEditorPendingDecision: vi.fn().mockResolvedValue(undefined),
  notifyReviewerAssigned: vi.fn().mockResolvedValue(undefined),
}));

const { createApp } = await import("../../src/app.js");
const notifications = await import("../../src/services/notifications.js");
const app = createApp();

const reviewerToken = signAccessToken("rev-1", Role.REVIEWER);

beforeEach(() => {
  resetPrismaMock();
  vi.mocked(notifications.notifyEditorAssignmentResponse).mockClear();
});

describe("POST /api/reviewer/assignments/:id/respond", () => {
  it("declines with a reason, keeps the row, and notifies the editor", async () => {
    prismaMock.reviewAssignment.findFirst.mockResolvedValue({
      id: "asg-1",
      assignedById: "editor-1",
      response: "PENDING",
      manuscript: { title: "A Paper" },
    });
    prismaMock.reviewAssignment.update.mockResolvedValue({
      id: "asg-1",
      manuscriptId: "m1",
      deadline: new Date(),
      progress: "NOT_STARTED",
      response: "DECLINED",
      declineReason: "Conflict of interest",
      respondedAt: new Date(),
      manuscript: { id: "m1", title: "A Paper", abstract: "", keywords: [], createdAt: new Date() },
      review: null,
    });
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({
      id: "rev-1",
      email: "rev@example.com",
      firstName: "Ray",
      lastName: "V",
    });

    const res = await request(app)
      .post("/api/reviewer/assignments/asg-1/respond")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ accept: false, reason: "Conflict of interest" });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe("DECLINED");
    expect(prismaMock.reviewAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ response: "DECLINED", declineReason: "Conflict of interest" }),
      }),
    );
    expect(notifications.notifyEditorAssignmentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: false, reason: "Conflict of interest", editorId: "editor-1" }),
    );
  });

  it("rejects a decline with no reason", async () => {
    const res = await request(app)
      .post("/api/reviewer/assignments/asg-1/respond")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ accept: false });
    expect(res.status).toBe(400);
  });

  it("409s when the assignment was already answered", async () => {
    prismaMock.reviewAssignment.findFirst.mockResolvedValue({
      id: "asg-1",
      assignedById: "editor-1",
      response: "ACCEPTED",
      manuscript: { title: "A Paper" },
    });

    const res = await request(app)
      .post("/api/reviewer/assignments/asg-1/respond")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ accept: true });
    expect(res.status).toBe(409);
  });
});
