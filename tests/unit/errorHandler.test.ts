import type { Request, Response } from "express";
import multer from "multer";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { asyncHandler } from "../../src/middleware/asyncHandler.js";

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

const req = {} as Request;
const next = vi.fn();

describe("errorHandler", () => {
  it("maps ZodError to 400 with details", () => {
    const res = mockRes();
    const zodError = z.object({ email: z.string().email() }).safeParse({ email: "nope" });
    errorHandler(!zodError.success ? zodError.error : null, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Validation failed" }),
    );
  });

  it("maps MulterError to 400", () => {
    const res = mockRes();
    errorHandler(new multer.MulterError("LIMIT_FILE_SIZE"), req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LIMIT_FILE_SIZE" }),
    );
  });

  it("uses the error's status when set", () => {
    const res = mockRes();
    const err = Object.assign(new Error("Not found"), { status: 404 });
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
  });

  it("defaults to 500 for unknown errors", () => {
    const res = mockRes();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorHandler(new Error("boom"), req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    spy.mockRestore();
  });
});

describe("asyncHandler", () => {
  it("forwards rejected promises to next()", async () => {
    const error = new Error("async failure");
    const handler = asyncHandler(async () => {
      throw error;
    });
    const nextFn = vi.fn();
    handler(req, mockRes(), nextFn);
    await new Promise((r) => setImmediate(r));
    expect(nextFn).toHaveBeenCalledWith(error);
  });

  it("does not call next() on success", async () => {
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    });
    const nextFn = vi.fn();
    const res = mockRes();
    handler(req, res, nextFn);
    await new Promise((r) => setImmediate(r));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(nextFn).not.toHaveBeenCalled();
  });
});
