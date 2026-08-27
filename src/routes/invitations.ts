import { Router } from "express";
import { z } from "zod";
import { AssignmentResponse, InvitationStatus, Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { hashToken } from "../utils/cryptoToken.js";
import { hashPassword } from "../utils/password.js";
import { normalizeRoles } from "../utils/roles.js";
import {
  clearAssignmentActionNotifications,
  notifyEditorAssignmentResponse,
  notifyEditorInvitationResponse,
} from "../services/notifications.js";

/**
 * Public (unauthenticated) endpoints behind the accept/decline links in
 * reviewer-invitation and review-assignment emails. A token is looked up
 * first as a `ReviewerInvitation.tokenHash`, then as a
 * `ReviewAssignment.responseToken` — the two never collide (both are 32-byte
 * random hex), so one route serves both flows.
 */
export const invitationsRouter = Router();

type Resolved =
  | {
      kind: "REVIEWER_INVITATION";
      invitation: {
        id: string;
        email: string;
        status: InvitationStatus;
        expiresAt: Date;
        invitedById: string;
      };
    }
  | {
      kind: "ASSIGNMENT";
      assignment: {
        id: string;
        response: AssignmentResponse;
        assignedById: string;
        reviewerId: string;
        manuscript: { title: string };
        reviewer: { email: string; firstName: string | null; lastName: string | null };
      };
    }
  | null;

async function resolveToken(rawToken: string): Promise<Resolved> {
  const tokenHash = hashToken(rawToken);

  const invitation = await prisma.reviewerInvitation.findUnique({
    where: { tokenHash },
    select: { id: true, email: true, status: true, expiresAt: true, invitedById: true },
  });
  if (invitation) return { kind: "REVIEWER_INVITATION", invitation };

  const assignment = await prisma.reviewAssignment.findUnique({
    where: { responseToken: tokenHash },
    select: {
      id: true,
      response: true,
      assignedById: true,
      reviewerId: true,
      manuscript: { select: { title: true } },
      reviewer: { select: { email: true, firstName: true, lastName: true } },
    },
  });
  if (assignment) return { kind: "ASSIGNMENT", assignment };

  return null;
}

/** Lets the landing page render the right copy before the user acts. */
invitationsRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const resolved = await resolveToken(req.params.token);
    if (!resolved) {
      res.status(404).json({ error: "This link is not valid." });
      return;
    }

    if (resolved.kind === "REVIEWER_INVITATION") {
      const { invitation } = resolved;
      const expired =
        invitation.status === InvitationStatus.PENDING && invitation.expiresAt.getTime() < Date.now();
      const existing = await prisma.user.findUnique({ where: { email: invitation.email } });
      res.json({
        type: "REVIEWER_INVITATION",
        email: invitation.email,
        status: expired ? "EXPIRED" : invitation.status,
        needsAccount: !existing,
      });
      return;
    }

    const { assignment } = resolved;
    res.json({
      type: "ASSIGNMENT",
      email: assignment.reviewer.email,
      title: assignment.manuscript.title,
      status: assignment.response,
      needsAccount: false,
    });
  }),
);

const acceptSchema = z.object({
  password: z.string().min(8).optional(),
  name: z.string().trim().max(200).optional(),
});

invitationsRouter.post(
  "/:token/accept",
  asyncHandler(async (req, res) => {
    const body = acceptSchema.parse(req.body);
    const resolved = await resolveToken(req.params.token);
    if (!resolved) {
      res.status(404).json({ error: "This link is not valid." });
      return;
    }

    if (resolved.kind === "REVIEWER_INVITATION") {
      const { invitation } = resolved;
      if (invitation.status !== InvitationStatus.PENDING) {
        res.status(410).json({ error: `This invitation was already ${invitation.status.toLowerCase()}.` });
        return;
      }
      if (invitation.expiresAt.getTime() < Date.now()) {
        await prisma.reviewerInvitation.update({
          where: { id: invitation.id },
          data: { status: InvitationStatus.EXPIRED },
        });
        res.status(410).json({ error: "This invitation has expired." });
        return;
      }

      const existing = await prisma.user.findUnique({ where: { email: invitation.email } });
      if (existing) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { roles: normalizeRoles(existing.role, [...existing.roles, Role.REVIEWER]) },
        });
      } else {
        if (!body.password) {
          res.status(400).json({ error: "Choose a password to create your reviewer account." });
          return;
        }
        const [firstName, ...rest] = (body.name ?? "").trim().split(/\s+/).filter(Boolean);
        await prisma.user.create({
          data: {
            email: invitation.email,
            passwordHash: await hashPassword(body.password),
            role: Role.REVIEWER,
            roles: [Role.REVIEWER],
            firstName: firstName || undefined,
            lastName: rest.length ? rest.join(" ") : undefined,
            // Invited by an editor who vouches for the address — same rule as
            // admin-provisioned accounts (see routes/admin.ts).
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
      }

      await prisma.reviewerInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.ACCEPTED, respondedAt: new Date() },
      });
      await notifyEditorInvitationResponse({
        editorId: invitation.invitedById,
        email: invitation.email,
        accepted: true,
      });
      res.json({ ok: true, type: "REVIEWER_INVITATION", accountCreated: !existing });
      return;
    }

    // Assignment accept.
    const { assignment } = resolved;
    if (assignment.response !== AssignmentResponse.PENDING) {
      res.status(410).json({ error: `This assignment was already ${assignment.response.toLowerCase()}.` });
      return;
    }
    await prisma.reviewAssignment.update({
      where: { id: assignment.id },
      data: {
        response: AssignmentResponse.ACCEPTED,
        respondedAt: new Date(),
        responseToken: null,
      },
    });
    await clearAssignmentActionNotifications(assignment.id);
    await notifyEditorAssignmentResponse({
      editorId: assignment.assignedById,
      reviewerName:
        [assignment.reviewer.firstName, assignment.reviewer.lastName].filter(Boolean).join(" ") ||
        assignment.reviewer.email,
      title: assignment.manuscript.title,
      accepted: true,
    });
    res.json({ ok: true, type: "ASSIGNMENT" });
  }),
);

const declineSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(2000),
});

invitationsRouter.post(
  "/:token/decline",
  asyncHandler(async (req, res) => {
    const body = declineSchema.parse(req.body);
    const resolved = await resolveToken(req.params.token);
    if (!resolved) {
      res.status(404).json({ error: "This link is not valid." });
      return;
    }

    if (resolved.kind === "REVIEWER_INVITATION") {
      const { invitation } = resolved;
      if (invitation.status !== InvitationStatus.PENDING) {
        res.status(410).json({ error: `This invitation was already ${invitation.status.toLowerCase()}.` });
        return;
      }
      await prisma.reviewerInvitation.update({
        where: { id: invitation.id },
        data: {
          status: InvitationStatus.DECLINED,
          declineReason: body.reason,
          respondedAt: new Date(),
        },
      });
      await notifyEditorInvitationResponse({
        editorId: invitation.invitedById,
        email: invitation.email,
        accepted: false,
        reason: body.reason,
      });
      res.json({ ok: true, type: "REVIEWER_INVITATION" });
      return;
    }

    const { assignment } = resolved;
    if (assignment.response !== AssignmentResponse.PENDING) {
      res.status(410).json({ error: `This assignment was already ${assignment.response.toLowerCase()}.` });
      return;
    }
    await prisma.reviewAssignment.update({
      where: { id: assignment.id },
      data: {
        response: AssignmentResponse.DECLINED,
        declineReason: body.reason,
        respondedAt: new Date(),
        responseToken: null,
      },
    });
    await clearAssignmentActionNotifications(assignment.id);
    await notifyEditorAssignmentResponse({
      editorId: assignment.assignedById,
      reviewerName:
        [assignment.reviewer.firstName, assignment.reviewer.lastName].filter(Boolean).join(" ") ||
        assignment.reviewer.email,
      title: assignment.manuscript.title,
      accepted: false,
      reason: body.reason,
    });
    res.json({ ok: true, type: "ASSIGNMENT" });
  }),
);
