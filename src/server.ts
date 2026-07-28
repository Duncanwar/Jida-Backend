import fs from "node:fs";
import { createApp } from "./app.js";
import { env, googleAuthEnabled } from "./config/env.js";
import { startScheduler } from "./services/scheduler.js";
import { verifyEmailTransport } from "./services/email.js";

if (!fs.existsSync(env.UPLOAD_DIR)) {
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
}

const app = createApp();
startScheduler();

// Email verification is a hard gate on sign-in, so a broken mail server means
// nobody can register. Surface that at boot rather than at the first signup.
void verifyEmailTransport().then((ok) => {
  if (!ok && env.NODE_ENV === "production") {
    console.error(
      "[startup] SMTP is unavailable in production — account registration will fail until this is fixed.",
    );
  }
});

console.info(
  `[startup] Google sign-in ${googleAuthEnabled ? "enabled" : "disabled (set GOOGLE_CLIENT_ID to enable)"}`,
);

app.listen(env.PORT, "0.0.0.0", () => {
  console.info(`JIDA API listening on port ${env.PORT}`);
});
