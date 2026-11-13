/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.7-alpha.1,
 * packages/llm/llm-deepseek/src/common/upload-index.ts.
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * no @deepseek-ai/* imports. The plugin's atomic-file helper coordinates writes.
 * The index path is explicit and stays beside the plugin's own state file.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { atomicFilePath, cleanAtomicTemps, isErrno, withWriterLock, writeAtomicFile } from '../../lib/atomic-file.mjs';
import { dirname } from 'node:path';
import { DeepSeekFileId, DeepSeekFileScope } from './file-id.mjs';
import type {
  AttachmentId, DeepSeekFileId as DeepSeekFileIdType, DeepSeekFileScope as DeepSeekFileScopeType, ImageVariantId,
} from './file-id.mjs';

/** One durable remote upload mapping. Unix times are milliseconds. */
export interface DeepSeekUploadRecord {
  scope: DeepSeekFileScopeType;
  /** Provider-independent normalized attachment from which the uploaded request version was derived. */
  attachmentId: AttachmentId;
  /** Complete request transformation identity, including route budgets and encoder parameters. */
  variantId: ImageVariantId;
  fileId: DeepSeekFileIdType;
  bytes: number;
  createdAt: number;
  expiresAt: number;
}

interface StoredIndex {
  formatVersion: 3;
  records: DeepSeekUploadRecord[];
}

class InvalidUploadIndexError extends Error {}

/** Candidate commit outcome when another process already published a reusable upload. */
export interface UploadIndexCommit {
  record: DeepSeekUploadRecord;
  accepted: boolean;
}

/**
 * Derive a non-secret stable index namespace without persisting or logging the API key.
 * @param baseURL - normalized provider endpoint namespace.
 * @param apiKey - resolved credential used only as hash input.
 * @returns branded SHA-256 namespace digest.
 */
export function deepSeekFileScope(baseURL: string, apiKey: string): DeepSeekFileScopeType {
  const digest = createHash('sha256')
    .update(baseURL.replace(/\/+$/u, ''))
    .update('\0')
    .update(apiKey)
    .digest('hex');
  return DeepSeekFileScope(digest);
}

function parseRecord(value: unknown): DeepSeekUploadRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('deepseek files: upload index contains a non-object record');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.scope !== 'string' || !/^[0-9a-f]{64}$/u.test(record.scope)
    || typeof record.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId)
    || typeof record.variantId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.variantId)
    || typeof record.fileId !== 'string' || record.fileId.length === 0
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
    throw new InvalidUploadIndexError('deepseek files: upload index contains an invalid record');
  }
  return {
    scope: DeepSeekFileScope(record.scope),
    attachmentId: record.attachmentId,
    variantId: record.variantId,
    fileId: DeepSeekFileId(record.fileId),
    bytes: record.bytes as number,
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number,
  };
}

function parseIndex(text: string): StoredIndex {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new InvalidUploadIndexError('deepseek files: upload index is not valid JSON', { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('deepseek files: upload index is not an object');
  }
  const index = value as { formatVersion?: unknown; records?: unknown };
  if (index.formatVersion !== 3 || !Array.isArray(index.records)) {
    throw new InvalidUploadIndexError('deepseek files: unsupported upload index format');
  }
  const records = index.records.map(parseRecord);
  const keys = new Set<string>();
  for (const record of records) {
    const key = record.scope + '\0' + record.variantId;
    if (keys.has(key)) throw new InvalidUploadIndexError('deepseek files: upload index contains duplicate mappings');
    keys.add(key);
  }
  return { formatVersion: 3, records };
}

function reusable(record: DeepSeekUploadRecord, now: number, refreshMarginMs: number): boolean {
  return record.expiresAt - now > refreshMarginMs;
}

/** Atomic local index shared by every DeepSeek session that uses one plugin state file. */
export class DeepSeekUploadIndex {
  /** Absolute owner-private JSON index path. */
  readonly path: string;
  #nextCleanup = 0;

  /**
   * @param path - explicit index path. The plugin entry derives it from its own
   *   state file (deepSeekFilesIndexPath), because the vendored tree cannot
   *   resolve the DSH home without a @deepseek-ai/* dependency.
   */
  constructor(path: string) {
    this.path = path;
  }

  private async load(path = this.path): Promise<StoredIndex> {
    try {
      return parseIndex(await readFile(path, 'utf8'));
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT') || error instanceof InvalidUploadIndexError) {
        return { formatVersion: 3, records: [] };
      }
      throw error;
    }
  }

  private async transaction<T>(fn: (path: string, index: StoredIndex) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const path = await atomicFilePath(this.path);
    return withWriterLock(path, async () => {
      if (Date.now() >= this.#nextCleanup) {
        this.#nextCleanup = Date.now() + 60 * 60 * 1_000;
        await cleanAtomicTemps(path).catch(error => console.warn('preset-enhance: could not scan upload index temp files', error));
      }
      return fn(path, await this.load(path));
    }, undefined, 10_000);
  }

  private async save(path: string, records: DeepSeekUploadRecord[]): Promise<void> {
    await writeAtomicFile(path, JSON.stringify({ formatVersion: 3, records }, undefined, 2) + '\n');
  }

  /**
   * Read one reusable mapping.
   * @param scope - endpoint/API-key namespace.
   * @param variantId - complete request-image transformation identity.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - remaining lifetime below which a mapping is not reused.
   * @returns the mapping when it has enough lifetime remaining.
   */
  async get(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantId,
    now: number,
    refreshMarginMs: number,
  ): Promise<DeepSeekUploadRecord | undefined> {
    const record = (await this.load()).records.find(candidate => (
      candidate.scope === scope && candidate.variantId === variantId
    ));
    return record !== undefined && reusable(record, now, refreshMarginMs) ? record : undefined;
  }

  /**
   * Publish a completed upload unless another process already published a reusable mapping.
   * @param candidate - completed remote upload.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - minimum reusable remaining lifetime.
   * @returns the winning record and whether the candidate entered the index.
   */
  async commit(
    candidate: DeepSeekUploadRecord,
    now: number,
    refreshMarginMs: number,
  ): Promise<UploadIndexCommit> {
    return this.transaction(async (path, index) => {
      const existing = index.records.find(record => (
        record.scope === candidate.scope
        && record.variantId === candidate.variantId
        && reusable(record, now, refreshMarginMs)
      ));
      if (existing !== undefined) return { record: existing, accepted: false };
      const records = index.records.filter(record => (
        reusable(record, now, refreshMarginMs)
        && !(record.scope === candidate.scope && record.variantId === candidate.variantId)
      ));
      records.push(candidate);
      await this.save(path, records);
      return { record: candidate, accepted: true };
    });
  }

  /**
   * Remove one exact mapping without deleting a concurrently installed successor.
   * @param scope - endpoint/API-key namespace.
   * @param variantId - complete request-image transformation identity.
   * @param fileId - exact remote generation being invalidated.
   */
  async remove(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantId,
    fileId: DeepSeekFileIdType,
  ): Promise<void> {
    await this.transaction(async (path, index) => {
      const records = index.records.filter(record => !(
        record.scope === scope && record.variantId === variantId && record.fileId === fileId
      ));
      if (records.length !== index.records.length) await this.save(path, records);
    });
  }

  /**
   * Remove every local mapping for one remote namespace.
   * @param scope - endpoint/API-key namespace.
   */
  async clear(scope: DeepSeekFileScopeType): Promise<void> {
    await this.transaction(async (path, index) => {
      const records = index.records.filter(record => record.scope !== scope);
      if (records.length !== index.records.length) await this.save(path, records);
    });
  }
}
