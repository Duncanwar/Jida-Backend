import fs from "node:fs";
import { createApp } from "./app.js";
import { env } from "./config/env.js";

if (!fs.existsSync(env.UPLOAD_DIR)) {
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
}

const app = createApp();

app.listen(env.PORT, "0.0.0.0", () => {
  console.info(`JIDA API listening on port ${env.PORT}`);
});
