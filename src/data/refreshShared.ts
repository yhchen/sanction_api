import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_METADATA_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export interface ChecksumMetadata {
  name: string;
  checksum: string;
  size?: number;
}

export async function downloadWithFetch(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Download failed for ${url} with HTTP ${response.status}`);
  if (!response.body) throw new Error(`Download failed for ${url}: empty response body.`);

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

export async function validateDownloadedResource(filePath: string, metadata: ChecksumMetadata): Promise<void> {
  const stats = await fs.stat(filePath);
  if (metadata.size !== undefined) {
    // A reported size of 0 is a legitimate "this resource is genuinely empty" signal from
    // OpenSanctions (observed for some small per-dataset targets.nested.json files), not
    // necessarily a failed download — trust the reported size over a blanket empty-file check.
    if (stats.size !== metadata.size) throw new Error(`${metadata.name} size mismatch.`);
  } else if (stats.size === 0) {
    throw new Error(`${metadata.name} download is empty.`);
  }
  await verifyChecksum(filePath, metadata);
}

export async function verifyChecksum(filePath: string, metadata: ChecksumMetadata): Promise<void> {
  const parsed = parseChecksum(metadata.checksum);
  if (!parsed) throw new Error(`${metadata.name} checksum format is not supported.`);
  const actual = await hashFile(filePath, parsed.algorithm);
  if (actual !== parsed.hex) throw new Error(`${metadata.name} checksum mismatch.`);
}

export function parseChecksum(checksum: string): { algorithm: 'sha256' | 'sha1' | 'md5'; hex: string } | undefined {
  const normalized = checksum.trim().toLocaleLowerCase('en-US');
  const prefixed = normalized.match(/^(sha256|sha1|md5)[:=]([a-f0-9]+)$/u);
  if (prefixed) return { algorithm: prefixed[1] as 'sha256' | 'sha1' | 'md5', hex: prefixed[2] };
  if (/^[a-f0-9]{64}$/u.test(normalized)) return { algorithm: 'sha256', hex: normalized };
  if (/^[a-f0-9]{40}$/u.test(normalized)) return { algorithm: 'sha1', hex: normalized };
  if (/^[a-f0-9]{32}$/u.test(normalized)) return { algorithm: 'md5', hex: normalized };
  return undefined;
}

export async function hashFile(filePath: string, algorithm: 'sha256' | 'sha1' | 'md5'): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function moveIfExists(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await fs.rename(sourcePath, destinationPath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function copyIfExists(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await fs.copyFile(sourcePath, destinationPath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function removeIfExists(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

export async function removeBackupFiles(filePaths: string[], logger: Pick<Console, 'warn'> = console): Promise<void> {
  const failures: string[] = [];
  for (const filePath of filePaths) {
    try {
      await removeIfExists(filePath);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${filePath}: ${reason}`);
    }
  }
  if (failures.length > 0) logger.warn('Refresh backup cleanup failed:', failures);
}

export function isDefinedString(value: string | undefined): value is string {
  return typeof value === 'string';
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Checks that every given path exists and is non-empty; used to detect a healthy previous refresh output. */
export async function localFilesPopulated(paths: Array<string | undefined>): Promise<boolean> {
  for (const filePath of paths.filter(isDefinedString)) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size === 0) return false;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

export interface FileSwapEntry {
  stagedPath: string;
  finalPath: string;
}

export interface ReplaceFilesAndMetadataOptions {
  files: FileSwapEntry[];
  sqlite?: FileSwapEntry;
  metadataPath: string;
  metadataTempPath: string;
  metadataContents: string;
  logger?: Pick<Console, 'warn'>;
  afterPublish?: () => Promise<void>;
}

/**
 * Atomically replaces an arbitrary set of local files plus an optional SQLite file and a
 * metadata file, backing up any existing files first so a failure partway through can be rolled
 * back. Shared by both the debarment and securities refresh pipelines.
 */
export async function replaceFilesAndMetadata(options: ReplaceFilesAndMetadataOptions): Promise<void> {
  for (const file of options.files) await fs.mkdir(path.dirname(file.finalPath), { recursive: true });
  if (options.sqlite) await fs.mkdir(path.dirname(options.sqlite.finalPath), { recursive: true });
  await fs.mkdir(path.dirname(options.metadataPath), { recursive: true });

  const backupSuffix = `.refresh-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fileBackups = options.files.map((file) => ({ ...file, backupPath: `${file.finalPath}${backupSuffix}` }));
  const sqliteBackupPath = options.sqlite ? `${options.sqlite.finalPath}${backupSuffix}` : undefined;
  const metadataBackupPath = `${options.metadataPath}${backupSuffix}`;

  const movedFiles = new Map<string, boolean>();
  let copiedSqlite = false;
  let movedMetadata = false;
  const publishedFiles = new Set<string>();
  let publishedSqlite = false;
  let publishedMetadata = false;

  try {
    for (const file of fileBackups) movedFiles.set(file.finalPath, await moveIfExists(file.finalPath, file.backupPath));
    copiedSqlite = options.sqlite && sqliteBackupPath ? await copyIfExists(options.sqlite.finalPath, sqliteBackupPath) : false;
    movedMetadata = await moveIfExists(options.metadataPath, metadataBackupPath);

    for (const file of options.files) {
      await fs.copyFile(file.stagedPath, file.finalPath);
      publishedFiles.add(file.finalPath);
    }
    if (options.sqlite) {
      await fs.copyFile(options.sqlite.stagedPath, options.sqlite.finalPath);
      publishedSqlite = true;
    }
    await fs.writeFile(options.metadataTempPath, options.metadataContents, 'utf8');
    await fs.rename(options.metadataTempPath, options.metadataPath);
    publishedMetadata = true;
    await options.afterPublish?.();
  } catch (error) {
    await removeIfExists(options.metadataTempPath);
    for (const file of fileBackups) {
      if (movedFiles.get(file.finalPath) || publishedFiles.has(file.finalPath)) await removeIfExists(file.finalPath);
    }
    if (options.sqlite && copiedSqlite && sqliteBackupPath) {
      await fs.copyFile(sqliteBackupPath, options.sqlite.finalPath);
    } else if (options.sqlite && publishedSqlite) {
      await removeIfExists(options.sqlite.finalPath);
    }
    if (movedMetadata || publishedMetadata) await removeIfExists(options.metadataPath);
    for (const file of fileBackups) {
      if (movedFiles.get(file.finalPath)) await fs.rename(file.backupPath, file.finalPath);
    }
    if (movedMetadata) await fs.rename(metadataBackupPath, options.metadataPath);
    throw error;
  }

  await removeBackupFiles(
    [...fileBackups.map((file) => file.backupPath), metadataBackupPath, sqliteBackupPath].filter(isDefinedString),
    options.logger,
  );
}
