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
});
