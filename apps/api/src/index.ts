import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Загружаем .env из нескольких мест, т.к. в dev/prod может отличаться cwd и __dirname.
const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(__dirname, "../../../.env"),
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../.env"),
];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
}

import express from "express";
import cors from "cors";
import { channelRouter } from "./routes/channel.js";
import { creativeRouter } from "./routes/creative.js";
import { telegramRouter } from "./routes/telegram.js";

const app = express();
const port = Number(process.env.API_PORT) || 3001;
const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json({ limit: "30mb" }));

app.use("/api/channel", channelRouter);
app.use("/api/creative", creativeRouter);
app.use("/api/telegram", telegramRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`API: http://localhost:${port}`);
});
