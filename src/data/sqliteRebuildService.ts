import { buildSqliteDatabase } from './sqliteBuilder.js';
import { SqliteSenzingRepository, SqliteTargetDetailsRepository } from './sqliteRepositories.js';
import type { RefreshResult } from './dataRefreshService.js';
import type {
  RepositoryStats,
  SenzingLookupRepository,
  SenzingRecord,
  TargetDetailsRepository,
} from '../domain/types.js';

export interface ReplaceableRepositories {
  replace(
    senzingRepository: SenzingLookupRepository,
    targetDetailsRepository?: TargetDetailsRepository,
  ): void;
}

export interface SqliteRebuildTarget {
  label: string;
  senzingPath: string;
  targetsNestedPath: string;
  sqlitePath: string;
  activeRepositories: ReplaceableRepositories;
  isIncludedRecord?: (record: SenzingRecord) => boolean;
  minFuzzyScore?: number;
}

export interface SqliteRebuildServiceOptions {
  targets: SqliteRebuildTarget[];
  minFuzzyScore?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

interface RebuiltTarget {
  target: SqliteRebuildTarget;
  senzingRepository: SqliteSenzingRepository;
  targetDetailsRepository: SqliteTargetDetailsRepository;
}

export class SqliteRebuildService {
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private activeRun?: Promise<RefreshResult>;

  constructor(private readonly options: SqliteRebuildServiceOptions) {
    this.logger = options.logger ?? console;
  }

  rebuildNow(): Promise<RefreshResult> {
    if (this.activeRun) {
      return Promise.resolve({ status: 'in_progress', message: 'SQLite database rebuild is already running.' });
    }

    this.activeRun = this.runRebuild().finally(() => {
      this.activeRun = undefined;
    });
    return this.activeRun;
  }

  private async runRebuild(): Promise<RefreshResult> {
    const rebuiltTargets: RebuiltTarget[] = [];
    try {
      if (this.options.targets.length === 0) throw new Error('No SQLite rebuild targets are configured.');

      for (const target of this.options.targets) {
        await buildSqliteDatabase({
          senzingPath: target.senzingPath,
          targetsNestedPath: target.targetsNestedPath,
          sqlitePath: target.sqlitePath,
          isIncludedRecord: target.isIncludedRecord,
        });

        rebuiltTargets.push(openRebuiltTarget(target, target.minFuzzyScore ?? this.options.minFuzzyScore));
      }

      for (const rebuiltTarget of rebuiltTargets) {
        rebuiltTarget.target.activeRepositories.replace(
          rebuiltTarget.senzingRepository,
          rebuiltTarget.targetDetailsRepository,
        );
      }

      const message = `SQLite databases rebuilt: ${rebuiltTargets.map(formatRebuiltTarget).join('; ')}.`;
      this.logger.info('SQLite databases rebuilt.', {
        targets: rebuiltTargets.map((rebuiltTarget) => ({
          label: rebuiltTarget.target.label,
          sqlitePath: rebuiltTarget.target.sqlitePath,
          senzing: rebuiltTarget.senzingRepository.stats(),
          targetDetails: rebuiltTarget.targetDetailsRepository.stats(),
        })),
      });
      return { status: 'updated', message };
    } catch (error: unknown) {
      closeRebuiltTargets(rebuiltTargets);
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('SQLite database rebuild failed:', reason);
      return { status: 'failed', message: `SQLite database rebuild failed: ${reason}`, error: reason };
    }
  }
}

function openRebuiltTarget(target: SqliteRebuildTarget, minFuzzyScore: number | undefined): RebuiltTarget {
  let senzingRepository: SqliteSenzingRepository | undefined;
  let targetDetailsRepository: SqliteTargetDetailsRepository | undefined;
  try {
    senzingRepository = SqliteSenzingRepository.open(target.sqlitePath, { minFuzzyScore });
    targetDetailsRepository = SqliteTargetDetailsRepository.open(target.sqlitePath);
    return { target, senzingRepository, targetDetailsRepository };
  } catch (error) {
    targetDetailsRepository?.close();
    senzingRepository?.close();
    throw error;
  }
}

function formatRebuiltTarget(rebuiltTarget: RebuiltTarget): string {
  const senzingStats = rebuiltTarget.senzingRepository.stats();
  const targetStats = rebuiltTarget.targetDetailsRepository.stats();
  return `${rebuiltTarget.target.label} ${formatStats(senzingStats)}, targetDetails=${targetStats.records}`;
}

function formatStats(stats: RepositoryStats): string {
  const indexedNames = stats.indexedNames === undefined ? '' : `, indexedNames=${stats.indexedNames}`;
  return `records=${stats.records}${indexedNames}`;
}

function closeRebuiltTargets(rebuiltTargets: RebuiltTarget[]): void {
  for (const rebuiltTarget of rebuiltTargets) {
    rebuiltTarget.targetDetailsRepository.close();
    rebuiltTarget.senzingRepository.close();
  }
}
