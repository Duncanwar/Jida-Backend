import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: err.flatten() });
    return;
  }
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  const status = (err as { status?: number }).status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
}
