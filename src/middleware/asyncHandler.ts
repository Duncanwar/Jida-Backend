import type { NextFunction, Request, Response } from "express";

export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}
