import type { RefreshResult, RefreshRunner } from './dataRefreshService.js';

/**
 * Wraps several independent refresh pipelines (e.g. debarment + securities) behind a single
 * `RefreshRunner`, so the bot's `/update` command can trigger both with one call. Runs every
 * runner in parallel and merges their results: failed wins over updated wins over current.
 */
export function createCombinedRefreshRunner(runners: RefreshRunner[]): RefreshRunner {
  return {
    async refreshNow(): Promise<RefreshResult> {
      const results = await Promise.all(runners.map((runner) => runner.refreshNow()));
      return mergeResults(results);
    },
  };
}

function mergeResults(results: RefreshResult[]): RefreshResult {
  const message = results.map((result) => result.message).join(' ');
  const failed = results.find((result) => result.status === 'failed');
  if (failed) {
    return { status: 'failed', message, error: results.filter((result) => result.error).map((result) => result.error).join(' ') };
  }
  const updated = results.find((result) => result.status === 'updated');
  if (updated) return { status: 'updated', version: updated.version, message };

  return { status: results.some((result) => result.status === 'in_progress') ? 'in_progress' : 'current', message };
}
