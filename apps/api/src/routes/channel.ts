import { Router } from "express";
import { parseChannelFromTme } from "../services/channelParser.js";

export const channelRouter = Router();

channelRouter.post("/analyze", async (req, res) => {
  try {
    const { link } = req.body as { link?: string };
    if (!link || typeof link !== "string") {
      res.status(400).json({ error: "Укажите link — ссылку на канал (t.me/username или @username)" });
      return;
    }
    const info = await parseChannelFromTme(link);
    res.json(info);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка анализа канала";
    res.status(400).json({ error: message });
  }
});
