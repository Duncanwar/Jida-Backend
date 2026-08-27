import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "../helpers/prismaMock.js";
import { hashToken } from "../../src/utils/cryptoToken.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../src/services/email.js", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  sendMailSafe: vi.fn().mockResolvedValue(true),
  verifyEmailTransport: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/notifications.js", () => ({
  clearAssignmentActionNotifications: vi.fn().mockResolvedValue(undefined),
  notifyEditorAssignmentResponse: vi.fn().mockResolvedValue(undefined),
  notifyEditorInvitationResponse: vi.fn().mockResolvedValue(undefined),
}));

const { createApp } = await import("../../src/app.js");
const notifications = await import("../../src/services/notifications.js");
const app = createApp();

const RAW = "a".repeat(64);
const HASH = hashToken(RAW);

beforeEach(() => {
  resetPrismaMock();
  vi.mocked(notifications.notifyEditorAssignmentResponse).mockClear();
  vi.mocked(notifications.notifyEditorInvitationResponse).mockClear();
});

function pendingInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    email: "newperson@example.com",
    status: "PENDING",
    expiresAt: new Date(Date.now() + 86_400_000),
    invitedById: "editor-1",
    ...overrides,
  };
}

describe("GET /api/invitations/:token", () => {
  it("404s an unknown token", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(null);
    prismaMock.reviewAssignment.findUnique.mockResolvedValue(null);

    const res = await request(app).get(`/api/invitations/${RAW}`);
    expect(res.status).toBe(404);
  });

  it("reports a reviewer invitation and whether an account is needed", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(pendingInvitation());
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await request(app).get(`/api/invitations/${RAW}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "REVIEWER_INVITATION",
      email: "newperson@example.com",
      status: "PENDING",
      needsAccount: true,
    });
  });
});

describe("POST /api/invitations/:token/accept — reviewer invitation", () => {
  it("provisions a verified REVIEWER account for a new email", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(pendingInvitation());
    prismaMock.reviewAssignment.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: "u-new" });
    prismaMock.reviewerInvitation.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/invitations/${RAW}/accept`)
      .send({ password: "supersecret", name: "New Person" });

    expect(res.status).toBe(200);
    expect(res.body.accountCreated).toBe(true);
    const createArg = prismaMock.user.create.mock.calls[0][0].data;
    expect(createArg.role).toBe("REVIEWER");
    expect(createArg.roles).toEqual(["REVIEWER"]);
    expect(createArg.emailVerified).toBe(true);
    expect(prismaMock.reviewerInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED" }) }),
    );
    expect(notifications.notifyEditorInvitationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: true, editorId: "editor-1" }),
    );
  });

  it("adds the REVIEWER role to an existing account without a password", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(pendingInvitation());
    prismaMock.reviewAssignment.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: "u-1", role: "AUTHOR", roles: ["AUTHOR"] });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.reviewerInvitation.update.mockResolvedValue({});

    const res = await request(app).post(`/api/invitations/${RAW}/accept`).send({});

    expect(res.status).toBe(200);
    const updateArg = prismaMock.user.update.mock.calls[0][0].data;
    expect(updateArg.roles).toEqual(expect.arrayContaining(["AUTHOR", "REVIEWER"]));
  });

  it("410s an invitation that was already answered", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(pendingInvitation({ status: "ACCEPTED" }));
    prismaMock.reviewAssignment.findUnique.mockResolvedValue(null);

    const res = await request(app).post(`/api/invitations/${RAW}/accept`).send({ password: "supersecret" });
    expect(res.status).toBe(410);
  });
});

describe("POST /api/invitations/:token/decline", () => {
  it("requires a reason", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(pendingInvitation());
    prismaMock.reviewAssignment.findUnique.mockResolvedValue(null);

    const res = await request(app).post(`/api/invitations/${RAW}/decline`).send({});
    expect(res.status).toBe(400);
  });

  it("stores the reason and notifies the editor", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(pendingInvitation());
    prismaMock.reviewAssignment.findUnique.mockResolvedValue(null);
    prismaMock.reviewerInvitation.update.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/invitations/${RAW}/decline`)
      .send({ reason: "No capacity this term" });

    expect(res.status).toBe(200);
    expect(prismaMock.reviewerInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DECLINED", declineReason: "No capacity this term" }),
      }),
    );
    expect(notifications.notifyEditorInvitationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: false, reason: "No capacity this term" }),
    );
  });
});

describe("POST /api/invitations/:token/accept — assignment token", () => {
  it("marks the assignment accepted and notifies the editor", async () => {
    prismaMock.reviewerInvitation.findUnique.mockResolvedValue(null);
    prismaMock.reviewAssignment.findUnique.mockResolvedValue({
      id: "asg-1",
      response: "PENDING",
      assignedById: "editor-1",
      reviewerId: "rev-1",
      manuscript: { title: "A Paper" },
      reviewer: { email: "rev@example.com", firstName: "Ray", lastName: "V" },
    });
    prismaMock.reviewAssignment.update.mockResolvedValue({});

    const res = await request(app).post(`/api/invitations/${RAW}/accept`).send({});

    expect(res.status).toBe(200);
    expect(prismaMock.reviewAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ response: "ACCEPTED" }) }),
    );
    expect(notifications.notifyEditorAssignmentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: true, title: "A Paper" }),
    );
  });
});
