import { defineConfig, devices } from "@playwright/test";

const htmlReportDir =
  process.env.PLAYWRIGHT_HTML_REPORT_DIR ?? "runtime/fulltest-docker/playwright-report";
const testResultsDir =
  process.env.PLAYWRIGHT_TEST_RESULTS_DIR ?? "runtime/fulltest-docker/test-results";

export default defineConfig({
  testDir: "./tests/web",
  outputDir: testResultsDir,
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: htmlReportDir }]],
  use: {
    baseURL: process.env.WEB_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
