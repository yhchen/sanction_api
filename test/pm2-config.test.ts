import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);

interface Pm2AppConfig {
  name?: string;
  script?: string;
  interpreter?: string;
  node_args?: string;
  cwd?: string;
  instances?: number;
  exec_mode?: string;
  autorestart?: boolean;
  watch?: boolean;
}

interface Pm2EcosystemConfig {
  apps?: Pm2AppConfig[];
}

describe('PM2 ecosystem config', () => {
  test('runs the built Telegram bot with production env file loading enabled', () => {
    const config = require(path.join(process.cwd(), 'ecosystem.config.cjs')) as Pm2EcosystemConfig;

    expect(config.apps).toHaveLength(1);
    expect(config.apps?.[0]).toMatchObject({
      name: 'sanction-api-telegram-bot',
      script: './dist/index.js',
      interpreter: 'node',
      node_args: '--env-file=.env',
      cwd: process.cwd(),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
    });
  });
});
