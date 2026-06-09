import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright/tests",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "playwright/playwright-report" }]],
  use: {},
  projects: [
    {
      name: "steam-monitor",
    },
  ],
});
