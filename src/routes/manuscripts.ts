import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { authMiddleware, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { notifyAuthorStatus, notifyEditorsNewSubmission } from "../services/notifications.js";
import { v4 as uuidv4 } from "uuid";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function ensureUploadDir(): void {
  if (!fs.existsSync(env.UPLOAD_DIR)) {
    fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    ensureUploadDir();
    cb(null, env.UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error("Only PDF and DOCX files are allowed"));
      return;
    }
    cb(null, true);
  },
});

export const manuscriptsRouter = Router();

manuscriptsRouter.use(authMiddleware, requireRole(Role.AUTHOR));

manuscriptsRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    console.log(req.body.title)
    const title = req.body?.title as string | undefined;
    const abstract = req.body?.abstract as string | undefined;
    const keywordsRaw = req.body?.keywords as string | undefined;
    const references = req.body?.references as string | undefined;

    if (!req.file || !title || !abstract || !references) {
      console.warn("Invalid", title)
      res.status(400).json({ error: "file, title, abstract, and references are required" });
      return;
    }

    const settings = await prisma.journalSettings.upsert({
      where: { id: 1 },
      create: { id: 1, openForSubmissions: true },
      update: {},
    });
    if (!settings.openForSubmissions) {
      res.status(403).json({ error: "Submissions are currently closed" });
      return;
    }
    if (settings.submissionDeadline && new Date() > settings.submissionDeadline) {
      res.status(403).json({ error: "Submission deadline has passed" });
      return;
    }

    const keywords = (keywordsRaw ?? "")
      .split(/[,;]/)
      .map((k) => k.trim())
      .filter(Boolean);

    const manuscript = await prisma.manuscript.create({
      data: {
        authorId: req.user!.id,
        title,
        abstract,
        keywords,
        references,
        files: {
          create: {
            storedName: req.file.filename,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            sizeBytes: req.file.size,
            versionLabel: 1,
            isLatest: true,
          },
        },
      },
      include: { files: true },
    });

    await notifyEditorsNewSubmission(manuscript.title);

    res.status(201).json(manuscript);
  }),
);

manuscriptsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where = {
      authorId: req.user!.id,
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { abstract: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const list = await prisma.manuscript.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        files: { where: { isLatest: true }, take: 1 },
        publication: { select: { slug: true, publishedAt: true } },
      },
    });
    res.json(list);
  }),
);

/** Published article PDF/DOCX for author (FR-A8) — must be registered before `/:id`. */
manuscriptsRouter.get(
  "/published/:slug/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const pub = await prisma.publication.findUnique({
      where: { slug: req.params.slug },
      include: {
        manuscript: {
          include: { files: { where: { isLatest: true }, take: 1 } },
        },
      },
    });
    if (!pub || pub.manuscript.authorId !== req.user!.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const file = pub.manuscript.files[0];
    if (!file) {
      res.status(404).json({ error: "No file" });
      return;
    }
    const abs = path.join(env.UPLOAD_DIR, file.storedName);
    res.download(abs, file.originalName);
  }),
);

manuscriptsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const m = await prisma.manuscript.findFirst({
      where: { id: req.params.id, authorId: req.user!.id },
      include: {
        files: { orderBy: { versionLabel: "desc" } },
        publication: true,
      },
    });
    if (!m) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }
    res.json(m);
  }),
);

manuscriptsRouter.post(
  "/:id/revisions",
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const manuscript = await prisma.manuscript.findFirst({
      where: { id: req.params.id, authorId: req.user!.id },
    });
    if (!manuscript) {
      res.status(404).json({ error: "Manuscript not found" });
      return;
    }
    if (manuscript.status !== "REVISION_REQUIRED") {
      res.status(400).json({ error: "Revisions only allowed when status is REVISION_REQUIRED" });
      return;
    }

    const latest = await prisma.manuscriptFile.findFirst({
      where: { manuscriptId: manuscript.id },
      orderBy: { versionLabel: "desc" },
    });
    const nextVersion = (latest?.versionLabel ?? 0) + 1;

    await prisma.$transaction([
      prisma.manuscriptFile.updateMany({
        where: { manuscriptId: manuscript.id },
        data: { isLatest: false },
      }),
      prisma.manuscriptFile.create({
        data: {
          manuscriptId: manuscript.id,
          storedName: req.file.filename,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          versionLabel: nextVersion,
          isLatest: true,
        },
      }),
      prisma.manuscript.update({
        where: { id: manuscript.id },
        data: { status: "UNDER_REVIEW" },
      }),
    ]);

    const author = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    await notifyAuthorStatus(author.email, manuscript.title, "UNDER_REVIEW");

    const updated = await prisma.manuscript.findUniqueOrThrow({
      where: { id: manuscript.id },
      include: { files: { orderBy: { versionLabel: "desc" } } },
    });
    res.status(201).json(updated);
  }),
);

manuscriptsRouter.get(
  "/:id/files/:fileId/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const file = await prisma.manuscriptFile.findFirst({
      where: {
        id: req.params.fileId,
        manuscript: { id: req.params.id, authorId: req.user!.id },
      },
    });
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const abs = path.join(env.UPLOAD_DIR, file.storedName);
    res.download(abs, file.originalName);
  }),
);
