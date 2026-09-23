import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5175',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'demo', testMatch: 'demo.spec.ts', use: { baseURL: 'http://127.0.0.1:5175' } },
    { name: 'api', testMatch: 'api.spec.ts', use: { baseURL: 'http://127.0.0.1:5176' } },
    { name: 'live', testMatch: 'live.spec.ts', use: { baseURL: 'http://127.0.0.1:5177' } },
  ],
  webServer: [
    {
      command: `${process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'} -m uvicorn backend.app:app --host 127.0.0.1 --port 8000`,
      url: 'http://127.0.0.1:8000/api/health',
      env: { ANALYSIS_MODE: 'deterministic' },
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run preview -- --port 5177 --strictPort',
      url: 'http://127.0.0.1:5177',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run dev -- --port 5175',
      url: 'http://127.0.0.1:5175',
      env: { VITE_USE_MOCK: 'true', VITE_API_BASE_URL: '' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run dev -- --port 5176',
      url: 'http://127.0.0.1:5176',
      env: { VITE_USE_MOCK: 'false', VITE_API_BASE_URL: '' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
