import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

/** 三角色非空项目真实 HTTP/专用 PostgreSQL 联调，不拦截业务响应。 */
export default defineConfig({
  ...baseConfig,
  testMatch: 'workbench-projects-real.spec.ts',
  timeout: 90_000,
  use: { ...baseConfig.use, actionTimeout: 15_000, navigationTimeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: 'artifacts/workbench-projects-real/results.json' }]],
  outputDir: 'artifacts/workbench-projects-real/test-results',
});
