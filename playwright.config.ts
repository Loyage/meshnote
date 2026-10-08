import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 960 },
    channel: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "rm -f .meshnote/e2e-dev/llm-settings.json && bun run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MESHNOTE_SETTINGS_FILE: ".meshnote/e2e-dev/llm-settings.json",
      MESHNOTE_LLM_API_KEY: "",
      MESHNOTE_LLM_BASE_URL: "https://api.openai.com/v1",
      MESHNOTE_LLM_MODEL: "gpt-4o-mini",
      MESHNOTE_LLM_TIMEOUT_MS: "120000",
    },
  },
});
