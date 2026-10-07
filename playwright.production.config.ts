import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "http://127.0.0.1:8787" },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:8787",
    reuseExistingServer: false,
    timeout: 30_000,
    env: { MESHNOTE_LLM_API_KEY: "" },
  },
});
