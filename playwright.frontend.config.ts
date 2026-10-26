import { defineConfig } from '@playwright/test';

/** 双端认证、个人中心、组织及角色视图使用隔离 HTTP 契约回归，不依赖业务数据库。 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    'frontend.spec.ts',
    'profile.spec.ts',
    'profile-attendance.spec.ts',
    'organizations.spec.ts',
    'organization-schedules.spec.ts',
    'organization-create.spec.ts',
    'organization-electron.spec.ts',
    'workspace-views.spec.ts',
    'navigator-projects.spec.ts',
    'project-manager.spec.ts',
  ],
  workers: 1,
  timeout: 30_000,
  reporter: [['list'], ['json', { outputFile: 'artifacts/frontend-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:5176',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command:
        'pnpm --filter @tyde/web exec vite preview --host 127.0.0.1 --port 5176 --strictPort',
      url: 'http://127.0.0.1:5176',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @tyde/web exec vite --host 127.0.0.1 --port 5177 --strictPort',
      url: 'http://127.0.0.1:5177',
      reuseExistingServer: false,
    },
  ],
});
