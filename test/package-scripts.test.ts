import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

interface PackageJson {
  scripts?: Record<string, string>;
}

async function readPackageJson(): Promise<PackageJson> {
  const rawPackageJson = await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(rawPackageJson) as PackageJson;
}

describe('package scripts', () => {
  test('loads .env.develop when running the dev script', async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.scripts?.dev).toBe('tsx --env-file=.env.develop src/index.ts');
  });

  test('provides PM2-managed production scripts', async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.scripts).toMatchObject({
      'pm2:start': 'npm run build && pm2 startOrReload ecosystem.config.cjs --update-env',
      'pm2:restart': 'npm run build && pm2 restart ecosystem.config.cjs --update-env',
      'pm2:stop': 'pm2 stop sanction-api-telegram-bot',
      'pm2:status': 'pm2 status sanction-api-telegram-bot',
      'pm2:logs': 'pm2 logs sanction-api-telegram-bot',
    });
  });
});
