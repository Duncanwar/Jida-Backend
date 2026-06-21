import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { manuscriptsRouter } from "./routes/manuscripts.js";
import { reviewerRouter } from "./routes/reviewer.js";
import { editorRouter } from "./routes/editor.js";
import { publicRouter } from "./routes/public.js";
import { settingsRouter } from "./routes/settings.js";

export function createApp(): express.Application {
  const app = express();

  if (env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(
    cors({
      origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "jida-backend" });
  });

  app.get("/", (_req, res) => {
    res.json({ ok: true, service: "jida-backend" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api", usersRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/manuscripts", manuscriptsRouter);
  app.use("/api/reviewer", reviewerRouter);
  app.use("/api/editor", editorRouter);
  app.use("/api/public", publicRouter);

  app.use(errorHandler);
  return app;
}
