import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
  use: {},
  projects: [
    {
      name: "steam-monitor",
    },
  ],
});
