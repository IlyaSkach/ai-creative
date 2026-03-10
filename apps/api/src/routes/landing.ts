import { Router } from "express";
import { parseLanding } from "../services/landingParser.js";

export const landingRouter = Router();

landingRouter.post("/analyze", async (req, res) => {
  try {
    const { link } = req.body as { link?: string };
    if (!link || typeof link !== "string") {
      res.status(400).json({ error: "Укажите link — ссылку на сайт или лендинг" });
      return;
    }
    const info = await parseLanding(link);
    res.json(info);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка анализа лендинга";
    res.status(400).json({ error: message });
  }
});
