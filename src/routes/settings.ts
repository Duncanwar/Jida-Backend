import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const settingsRouter = Router();

settingsRouter.get(
  "/submission",
  asyncHandler(async (_req, res) => {
    const row = await prisma.journalSettings.findUnique({ where: { id: 1 } });
    if (!row) {
      await prisma.journalSettings.create({
        data: { id: 1, openForSubmissions: true },
      });
    }
    const s = await prisma.journalSettings.findUniqueOrThrow({ where: { id: 1 } });
    res.json({
      submissionDeadline: s.submissionDeadline,
      openForSubmissions: s.openForSubmissions,
    });
  }),
);
