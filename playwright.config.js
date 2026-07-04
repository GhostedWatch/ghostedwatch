import { defineConfig } from '@playwright/test'

// E2E tests load the REAL built extension (dist-chrome-dev) in Chromium and verify
// behavior the way a user would see it. Run `yarn build-chrome` first.
export default defineConfig({
    testDir: './tests/e2e',
    timeout: 30000,
    retries: 0,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
})
