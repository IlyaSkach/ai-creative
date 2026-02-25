/**
 * Вход в Telegram и сохранение сессии для анализа постов каналов.
 * Запуск: npm run login (из папки apps/api) или npm run login --workspace=apps/api (из корня ai-creative).
 *
 * Перед запуском в .env (в корне ai-creative) должны быть:
 *   TELEGRAM_API_ID=...
 *   TELEGRAM_API_HASH=...
 * После входа строка сессии сохранится в session/session.txt и будет выведена для копирования в TELEGRAM_SESSION_STRING.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import dotenv from "dotenv";
import inquirer from "inquirer";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Уменьшаем шум логов gramjs (миграция DC и т.д.)
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  const msg = args.join(" ");
  if (typeof msg === "string" && (msg.includes("[INFO]") || msg.includes("[WARN]") || msg.includes("gramJS"))) return;
  originalConsoleLog.apply(console, args);
};

// Загружаем .env из корня проекта ai-creative
const rootEnv = path.resolve(__dirname, "../../../.env");
const apiEnv = path.resolve(__dirname, "../.env");
dotenv.config({ path: rootEnv });
dotenv.config({ path: apiEnv });

const apiId = process.env.TELEGRAM_API_ID;
const apiHash = process.env.TELEGRAM_API_HASH;

function openUrlBestEffort(url: string) {
  const quoted = `"${url.replace(/"/g, '\\"')}"`;
  if (process.platform === "darwin") {
    exec(`open ${quoted}`, () => {});
    return;
  }
  if (process.platform === "win32") {
    exec(`start "" ${quoted}`, () => {});
    return;
  }
  exec(`xdg-open ${quoted}`, () => {});
}

async function main() {
  if (!apiId || !apiHash) {
    console.error(
      "Задайте TELEGRAM_API_ID и TELEGRAM_API_HASH в .env (в корне ai-creative).\n" +
        "Как получить: см. ИНСТРУКЦИЯ_TELEGRAM_КЛИЕНТ.md"
    );
    process.exit(1);
  }

  const maxAttempts = 2;
  let lastError: Error | null = null;
  const { authMethod } = await inquirer.prompt([
    {
      type: "list",
      name: "authMethod",
      message: "Способ входа в Telegram",
      choices: [
        { name: "Код в Telegram (по умолчанию)", value: "code_app" },
        { name: "Код по SMS (force SMS)", value: "code_sms" },
        { name: "QR (без ввода кода)", value: "qr" },
      ],
      default: "code_app",
    },
  ]);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = new TelegramClient(
      new StringSession(""),
      Number(apiId),
      apiHash,
      {
        connectionRetries: 10,
        useWSS: false,
        timeout: 60,
        requestRetries: 3,
      }
    );

    try {
      await client.connect();

      let cachedPassword = "";

      const askPassword = async () => {
        if (cachedPassword) return cachedPassword;
        const { hasPassword } = await inquirer.prompt([
          {
            type: "confirm",
            name: "hasPassword",
            message: "Включена ли двухэтапная аутентификация (2FA)?",
            default: false,
          },
        ]);
        if (!hasPassword) return "";
        const { password } = await inquirer.prompt([
          {
            type: "password",
            name: "password",
            message: "Пароль 2FA",
          },
        ]);
        cachedPassword = password || "";
        return cachedPassword;
      };
      const askPasswordQuick = async () => {
        if (cachedPassword) return cachedPassword;
        const { password } = await inquirer.prompt([
          {
            type: "password",
            name: "password",
            message: "Пароль 2FA (если не включен — просто Enter)",
          },
        ]);
        cachedPassword = password || "";
        return cachedPassword;
      };

      if (authMethod === "qr") {
        console.log(
          "\nСейчас появится ссылка для QR-входа.\n" +
            "Откройте Telegram на телефоне: Настройки -> Устройства -> Подключить устройство и отсканируйте QR.\n"
        );
        await client.signInUserWithQrCode(
          { apiId: Number(apiId), apiHash },
          {
            qrCode: async ({ token, expires }) => {
              const link = `tg://login?token=${token.toString("base64url")}`;
              const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(link)}`;
              console.log("\nQR login link (сгенерируйте из неё QR):");
              console.log(link);
              console.log("Готовый QR (откройте ссылку в браузере):");
              console.log(qrImageUrl);
              openUrlBestEffort(qrImageUrl);
              console.log("Срок действия токена (unix):", expires);
            },
            password: askPasswordQuick,
            onError: async (err) => {
              console.error(err);
              return false;
            },
          }
        );
      } else {
        await client.start({
          phoneNumber: async () => {
            const { phone } = await inquirer.prompt([
              {
                type: "input",
                name: "phone",
                message: "Номер телефона в международном формате (+7...)",
                validate: (v: string) => (v && v.startsWith("+") ? true : "Укажите номер с +"),
              },
            ]);
            return phone;
          },
          phoneCode: async () => {
            const { code } = await inquirer.prompt([
              {
                type: "input",
                name: "code",
                message: authMethod === "code_sms" ? "Код из SMS" : "Код из Telegram (сообщение или СМС)",
                validate: (v: string) => (v && v.length >= 3 ? true : "Введите код"),
              },
            ]);
            return code;
          },
          password: askPassword,
          onError: (err) => console.error(err),
          forceSMS: authMethod === "code_sms",
        });
      }

      const sessionString = client.session.save();
      await client.disconnect();

      // Сохраняем в session/session.txt (относительно корня ai-creative)
      const sessionDir = path.resolve(__dirname, "../../../session");
      const sessionFile = path.join(sessionDir, "session.txt");
      fs.mkdirSync(sessionDir, { recursive: true });
      // В типах gramjs save() может быть void, но по факту всегда возвращает строку
      fs.writeFileSync(sessionFile, String(sessionString ?? ""), "utf8");

      console.log("\n✅ Вход выполнен.\n");
      console.log("Сессия сохранена в:", sessionFile);
      console.log("\nДобавьте в .env (в корне ai-creative):\n");
      console.log("TELEGRAM_SESSION_STRING=" + sessionString);
      console.log("\n(или скопируйте содержимое файла session/session.txt в переменную TELEGRAM_SESSION_STRING)");
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      try {
        await client.disconnect();
      } catch {}
      const msg = lastError.message.toLowerCase();
      const isFlood = msg.includes("phone_password_flood") || msg.includes("flood_wait");
      if (isFlood) {
        throw new Error(
          "Telegram временно ограничил попытки входа (PHONE_PASSWORD_FLOOD/FLOOD_WAIT).\n" +
            "Сделайте паузу (обычно от 15 минут до нескольких часов), затем попробуйте снова.\n" +
            "Рекомендуется вход через QR и корректный пароль 2FA."
        );
      }
      const isConnection = msg.includes("connection") || msg.includes("migrat") || msg.includes("closed") || msg.includes("timeout");
      if (attempt < maxAttempts && isConnection) {
        console.error("\nОшибка соединения (возможна миграция DC). Повтор через 3 сек...\n");
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        throw lastError;
      }
    }
  }

  throw lastError || new Error("Вход не удался");
}

main().catch((err) => {
  console.error("Ошибка:", err?.message || err);
  process.exit(1);
});
