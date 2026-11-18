import { defineConfig } from '@playwright/test';
import config from './playwright.config';

const executablePath = process.env.SHELF_QA_CHROMIUM_PATH;
export default defineConfig({
  ...config,
  use: {
    ...config.use,
    ...(executablePath ? {
      launchOptions: {
        executablePath,
        args: JSON.parse(process.env.SHELF_QA_CHROMIUM_ARGS ?? '[]'),
      },
    } : {}),
  },
});
