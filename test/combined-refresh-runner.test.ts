import { describe, expect, test } from 'vitest';
import { createCombinedRefreshRunner } from '../src/data/combinedRefreshRunner.js';
import type { RefreshResult, RefreshRunner } from '../src/data/dataRefreshService.js';

function runner(result: RefreshResult): RefreshRunner {
  return { refreshNow: async () => result };
}

describe('createCombinedRefreshRunner', () => {
  test('reports current when every runner is current', async () => {
    const combined = createCombinedRefreshRunner([
      runner({ status: 'current', message: 'debarment current' }),
      runner({ status: 'current', message: 'securities current' }),
    ]);

    await expect(combined.refreshNow()).resolves.toMatchObject({ status: 'current', message: 'debarment current securities current' });
  });

  test('reports updated when any runner updated, even if others are current', async () => {
    const combined = createCombinedRefreshRunner([
      runner({ status: 'current', message: 'debarment current' }),
      runner({ status: 'updated', version: 'v2', message: 'securities updated' }),
    ]);

    await expect(combined.refreshNow()).resolves.toMatchObject({ status: 'updated', version: 'v2' });
  });

  test('reports failed when any runner fails, even if others updated', async () => {
    const combined = createCombinedRefreshRunner([
      runner({ status: 'updated', version: 'v2', message: 'debarment updated' }),
      runner({ status: 'failed', message: 'securities failed', error: 'boom' }),
    ]);

    await expect(combined.refreshNow()).resolves.toMatchObject({ status: 'failed', error: 'boom' });
  });

  test('runs all runners even though results are merged sequentially', async () => {
    let calls = 0;
    const combined = createCombinedRefreshRunner([
      { refreshNow: async () => { calls += 1; return { status: 'current', message: 'a' }; } },
      { refreshNow: async () => { calls += 1; return { status: 'current', message: 'b' }; } },
    ]);

    await combined.refreshNow();

    expect(calls).toBe(2);
  });
});
