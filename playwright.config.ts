import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: process.env.PIXELGATE_TEST_URL || 'http://127.0.0.1:8787',
    headless: true,
  },
  webServer: process.env.PIXELGATE_TEST_URL
    ? undefined
    : {
        command: 'npm start',
        url: 'http://127.0.0.1:8787',
        reuseExistingServer: !process.env.CI,
      },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        },
      },
    },
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        launchOptions: {
          firefoxUserPrefs: {
            'media.peerconnection.ice.obfuscate_host_addresses': false,
          },
        },
      },
    },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  reporter: 'list',
});
