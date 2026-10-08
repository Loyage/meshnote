import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
const port = Number(process.env.MESHNOTE_E2E_PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("MESHNOTE_E2E_PORT 必须为有效端口");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL },
  webServer: {
    command: "rm -f .meshnote/e2e-production/llm-settings.json && bun run start",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MESHNOTE_PORT: String(port),
      MESHNOTE_SETTINGS_FILE: ".meshnote/e2e-production/llm-settings.json",
      MESHNOTE_LLM_API_KEY: "",
      MESHNOTE_LLM_BASE_URL: "https://api.openai.com/v1",
      MESHNOTE_LLM_MODEL: "gpt-4o-mini",
      MESHNOTE_LLM_TIMEOUT_MS: "120000",
    },
  },
});
