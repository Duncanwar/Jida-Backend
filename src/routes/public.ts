import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendNewsletterWelcome } from "../services/newsletter.js";

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

/**
 * Public announcements — a call for papers is worthless if it only reaches
 * people who already have an account.
 *
 * Only rows explicitly marked public are served. Internal notices stay
 * invisible here, which is why `isPublic` defaults to false.
 */
publicRouter.get(
  "/announcements",
  asyncHandler(async (_req, res) => {
    const announcements = await prisma.announcement.findMany({
      where: { isPublic: true },
      select: { id: true, slug: true, title: true, body: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(announcements);
  }),
);

publicRouter.get(
  "/announcements/:slug",
  asyncHandler(async (req, res) => {
    const announcement = await prisma.announcement.findFirst({
      where: { slug: req.params.slug, isPublic: true },
      select: { id: true, slug: true, title: true, body: true, createdAt: true },
    });
    if (!announcement) {
      res.status(404).json({ error: "Announcement not found" });
      return;
    }
    res.json(announcement);
  }),
);

const subscribeSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
});

publicRouter.post(
  "/subscribe",
  asyncHandler(async (req, res) => {
    const body = subscribeSchema.parse(req.body);

    // Idempotent — resubscribing (or double-clicking the button) is a no-op,
    // not an error the reader needs to see.
    // Resubscribing clears a previous unsubscribe and issues a fresh token, so
    // the old link in an old email can no longer remove the new subscription.
    const subscriber = await prisma.newsletterSubscriber.upsert({
      where: { email: body.email },
      create: { email: body.email },
      update: { unsubscribedAt: null, unsubscribeToken: randomUUID() },
    });

    // Best-effort: the address is saved either way. Telling the reader the
    // subscription failed because our mail server hiccuped would be wrong.
    await sendNewsletterWelcome(subscriber.email, subscriber.unsubscribeToken);

    res.status(201).json({ message: "Subscribed" });
  }),
);
/**
 * Unsubscribe from the reader newsletter.
 *
 * Reachable with nothing but the token from the email footer — readers have no
 * account to sign in to. Idempotent: clicking an old link again, or a link for
 * an address already removed, still reports success rather than an error the
 * reader can do nothing about.
 */
publicRouter.post(
  "/unsubscribe/:token",
  asyncHandler(async (req, res) => {
    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { unsubscribeToken: req.params.token },
      select: { id: true, email: true, unsubscribedAt: true },
    });
    if (!subscriber) {
      res.status(404).json({ error: "This unsubscribe link is not valid." });
      return;
    }
    if (!subscriber.unsubscribedAt) {
      await prisma.newsletterSubscriber.update({
        where: { id: subscriber.id },
        data: { unsubscribedAt: new Date() },
      });
    }
    res.json({ message: "Unsubscribed", email: subscriber.email });
  }),
);

