import { defineConfig } from '@playwright/test';

const webPort = Number(process.env.SMART_TV_TEST_WEB_PORT ?? 5173);

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`, viewport: { width: 1920, height: 1080 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  workers: 1,
  webServer: [
    { command: 'bash ../../scripts/run-browser-host.sh', url: 'http://127.0.0.1:5082/api/health', reuseExistingServer: false },
    { command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`, url: `http://127.0.0.1:${webPort}`, reuseExistingServer: false },
    { command: 'DOTNET_ROOT=../../.local/dotnet DOTNET_CLI_HOME=../../.local NUGET_PACKAGES=../../.local/nuget ../../.local/dotnet/dotnet run --no-build --no-restore --no-launch-profile --project ../api --urls http://127.0.0.1:5080', url: 'http://127.0.0.1:5080/api/health', reuseExistingServer: false },
  ],
});
