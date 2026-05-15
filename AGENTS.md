## Cursor Cloud specific instructions

This workspace contains an npm workspaces monorepo with two apps: `apps/api` (Express + TypeScript) and `apps/web` (React + Vite + TypeScript).

### Running the dev environment

```bash
npm run dev        # starts both API and Web concurrently
npm run dev:api    # API only (tsx watch) on port defined by API_PORT (default 3001)
npm run dev:web    # Vite dev server on http://localhost:5173
```

### Key gotchas

- The Vite proxy in `apps/web/vite.config.ts` sends `/api` requests to **port 3002**, not the default 3001. Set `API_PORT=3002` in `.env` at the repo root to make the proxy work correctly.
- `.env` is loaded from the repo root by the API server (it searches multiple candidate paths).
- The project has no lint or test scripts configured. Use `npm run build` to verify TypeScript compilation and Vite build.
- API keys (`DEEPSEEK_API_KEY`, `BOTHUB_API_KEY`, `TELEGRAM_BOT_TOKEN`) are required for full functionality but the server starts and serves the web UI without them. Use placeholder values for basic dev/UI work.
- The Telegram bot (`TELEGRAM_SESSION_STRING`) is optional and only needed for deep post analysis.

### Build

```bash
npm run build   # tsc for API + vite build for Web
```
