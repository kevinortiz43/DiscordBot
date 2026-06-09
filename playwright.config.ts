import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright/tests",
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "playwright/playwright-report" }]],
  use: {},
  projects: [
    {
      name: "steam-monitor",
      // No browserName — no browser is launched
    },
  ],
});
