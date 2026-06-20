import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

interface LaunchJson {
  version?: string;
  configurations?: Array<Record<string, unknown>>;
}

async function readLaunchJson(): Promise<LaunchJson> {
  const rawLaunchJson = await fs.readFile(path.join(process.cwd(), '.vscode/launch.json'), 'utf8');
  return JSON.parse(rawLaunchJson) as LaunchJson;
}

describe('VS Code debug configuration', () => {
  test('runs npm run dev on F5 and kills the process tree when debugging stops', async () => {
    const launchJson = await readLaunchJson();
    const devConfig = launchJson.configurations?.find((config) => config.name === 'Debug npm run dev');

    expect(launchJson.version).toBe('0.2.0');
    expect(devConfig).toMatchObject({
      type: 'node',
      request: 'launch',
      runtimeExecutable: 'npm',
      runtimeArgs: ['run', 'dev'],
      cwd: '${workspaceFolder}',
      console: 'integratedTerminal',
      autoAttachChildProcesses: true,
      killBehavior: 'forceful',
    });
  });
});
