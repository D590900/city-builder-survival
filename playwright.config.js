import { defineConfig, devices } from '@playwright/test';

// E2E smoke tests for Last Refuge. They run against the production build
// served by `vite preview` (the webServer below builds it first), at the
// same /city-builder-survival/ base path used on GitHub Pages.
export default defineConfig({
  testDir: './e2e',
  // A full day/night cycle at 3x speed takes ~50 s of wall time; keep the
  // budget generous for software-rendered WebGL in headless Chromium.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    launchOptions: {
      // Allow software WebGL (SwiftShader) on GPU-less headless runners.
      args: ['--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173/city-builder-survival/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
