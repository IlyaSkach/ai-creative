import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Загружаем .env: сначала из текущей папки (при npm run dev из корня — это ai-creative), затем из путей относительно api
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import express from "express";
import cors from "cors";
import { channelRouter } from "./routes/channel.js";
import { creativeRouter } from "./routes/creative.js";
import { telegramRouter } from "./routes/telegram.js";

const app = express();
const port = Number(process.env.API_PORT) || 3001;
const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json({ limit: "10mb" }));

app.use("/api/channel", channelRouter);
app.use("/api/creative", creativeRouter);
app.use("/api/telegram", telegramRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`API: http://localhost:${port}`);
});
