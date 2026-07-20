import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock, resetPrismaMock } from "../helpers/prismaMock.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../src/services/email.js", () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));

const { createApp } = await import("../../src/app.js");
const app = createApp();

beforeEach(() => resetPrismaMock());

describe("GET /health", () => {
  it("responds ok without touching the database", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "jida-backend" });
  });
});

describe("GET /api/public/issues", () => {
  it("returns issues ordered newest first", async () => {
    const issues = [
      { id: "i2", year: 2026, volume: 2, issueNumber: 1, _count: { publications: 3 } },
      { id: "i1", year: 2025, volume: 1, issueNumber: 1, _count: { publications: 5 } },
    ];
    prismaMock.issue.findMany.mockResolvedValue(issues);

    const res = await request(app).get("/api/public/issues");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const arg = prismaMock.issue.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual([{ year: "desc" }, { volume: "desc" }, { issueNumber: "desc" }]);
  });
});

describe("GET /api/public/articles", () => {
  it("returns published articles without filters", async () => {
    prismaMock.publication.findMany.mockResolvedValue([]);
    const res = await request(app).get("/api/public/articles");
    expect(res.status).toBe(200);
    const arg = prismaMock.publication.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({});
  });

  it("applies a case-insensitive text search over title/abstract/references", async () => {
    prismaMock.publication.findMany.mockResolvedValue([]);
    await request(app).get("/api/public/articles").query({ q: "machine learning" });
    const arg = prismaMock.publication.findMany.mock.calls[0][0];
    expect(arg.where.manuscript.OR).toEqual([
      { title: { contains: "machine learning", mode: "insensitive" } },
      { abstract: { contains: "machine learning", mode: "insensitive" } },
      { references: { contains: "machine learning", mode: "insensitive" } },
    ]);
  });

  it("filters by keyword", async () => {
    prismaMock.publication.findMany.mockResolvedValue([]);
    await request(app).get("/api/public/articles").query({ keyword: "AI" });
    const arg = prismaMock.publication.findMany.mock.calls[0][0];
    expect(arg.where.manuscript.keywords).toEqual({ has: "AI" });
  });

  it("returns 500 via the error handler when the database fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.publication.findMany.mockRejectedValue(new Error("db down"));
    const res = await request(app).get("/api/public/articles");
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});
