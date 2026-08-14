import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const publicRouter = Router();

/**
 * Author details carried on every published article.
 *
 * The email is included deliberately: on a published article the submitting
 * author is the corresponding author, and journals list that contact alongside
 * the affiliation. It is only ever exposed for work that has been published —
 * manuscripts under review never reach these routes.
 */
const PUBLIC_AUTHOR_SELECT = {
  firstName: true,
  lastName: true,
  email: true,
  affiliation: true,
} as const;

/** Everything the archive and the citation metadata need about an article. */
const PUBLIC_MANUSCRIPT_SELECT = {
  id: true,
  title: true,
  abstract: true,
  keywords: true,
  references: true,
  author: { select: PUBLIC_AUTHOR_SELECT },
  coAuthors: {
    orderBy: { position: "asc" },
    select: { fullName: true, email: true, affiliation: true, isCorresponding: true },
  },
} as const;

publicRouter.get(
  "/issues",
  asyncHandler(async (_req, res) => {
    const issues = await prisma.issue.findMany({
      orderBy: [{ year: "desc" }, { volume: "desc" }, { issueNumber: "desc" }],
      include: {
        _count: { select: { publications: true } },
        // Everything published in the issue travels with it, so the archive can
        // present one card per volume+issue with its contents inside rather
        // than a flat list of articles.
        publications: {
          orderBy: { publishedAt: "asc" },
          select: {
            id: true,
            slug: true,
            publishedAt: true,
            manuscript: { select: PUBLIC_MANUSCRIPT_SELECT },
          },
        },
      },
    });
    res.json(issues);
  }),
);

publicRouter.get(
  "/articles",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const kw = typeof req.query.keyword === "string" ? req.query.keyword.trim() : "";

    const manuscriptFilter: {
      OR?: Array<Record<string, unknown>>;
      keywords?: { has: string };
    } = {};
    if (q) {
      manuscriptFilter.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { abstract: { contains: q, mode: "insensitive" } },
        { references: { contains: q, mode: "insensitive" } },
      ];
    }
    if (kw) {
      manuscriptFilter.keywords = { has: kw };
    }

    const publications = await prisma.publication.findMany({
      where: Object.keys(manuscriptFilter).length ? { manuscript: manuscriptFilter } : {},
      orderBy: { publishedAt: "desc" },
      include: {
        issue: true,
        manuscript: { select: PUBLIC_MANUSCRIPT_SELECT },
      },
      take: 100,
    });
    res.json(publications);
  }),
);

publicRouter.get(
  "/articles/:slug",
  asyncHandler(async (req, res) => {
    const pub = await prisma.publication.findUnique({
      where: { slug: req.params.slug },
      include: {
        issue: true,
        manuscript: { select: PUBLIC_MANUSCRIPT_SELECT },
      },
    });
    if (!pub) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    res.json(pub);
  }),
);

publicRouter.get(
  "/articles/:slug/download",
  asyncHandler(async (req, res) => {
    const pub = await prisma.publication.findUnique({
      where: { slug: req.params.slug },
      include: {
        manuscript: {
          include: { files: { where: { isLatest: true }, take: 1 } },
        },
      },
    });
    if (!pub) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    const file = pub.manuscript.files[0];
    if (!file) {
      res.status(404).json({ error: "No file" });
      return;
    }
    const abs = path.join(env.UPLOAD_DIR, file.storedName);
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "File missing" });
      return;
    }
    res.download(abs, file.originalName);
  }),
);
