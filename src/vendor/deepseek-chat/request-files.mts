/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.7-alpha.1,
 * packages/llm/llm-deepseek/src/common/request-files.ts.
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1:
 * self-contained (no @deepseek-ai/* imports). The host dsh-timeout deadline()
 * helper is replaced locally by deadlineSignal (linked AbortController plus a
 * bounded timer that the caller clears), and RequestFiles never resolves a
 * version without an attachmentId/variantId: the file path must fail cleanly so
 * the request can fall back to inline base64 instead of caching a guessed key.
 */

import type { RequestImageAttachment } from './host-types.mjs';
import type { DeepSeekFileConnection, DeepSeekFilePolicy, DeepSeekFileReference, DeepSeekFileStore } from './file-store.mjs';
import type { DeepSeekFileId } from './file-id.mjs';

/** Position of an image occurrence in the request's conversation messages. */
export interface ImageWireLocation {
  message: number;
  image: number;
}

/** A file upload failure eligible for request-wide inline fallback. */
export class FileResolutionFailure extends Error {
  constructor(cause: unknown) {
    super('DeepSeek Files API could not resolve a request image.', { cause });
    this.name = 'FileResolutionFailure';
  }
}

/** Per-image resolution deadline linked to the request signal. */
interface Deadline {
  signal: AbortSignal;
  clear(): void;
}

/** Local replacement for the host deadline helper: abort on timeout or request abort. */
function deadlineSignal(signal: AbortSignal, timeoutMs: number, code: string): Deadline {
  const controller = new AbortController();
  const onAbort = (): void => { controller.abort(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) controller.abort(signal.reason);
  const timer = setTimeout(() => { controller.abort(new Error(code)); }, timeoutMs);
  return {
    signal: controller.signal,
    clear(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

/** The upload path requires a real cache identity; a guessed key must never be persisted. */
function requireUploadIdentity(version: RequestImageAttachment): void {
  const attachmentId = version.attachment?.attachmentId;
  const variantId = version.variantId;
  if (typeof attachmentId !== 'string' || attachmentId.length === 0
    || typeof variantId !== 'string' || variantId.length === 0) {
    throw new FileResolutionFailure(new Error('DeepSeek request image is missing its attachmentId/variantId upload identity.'));
  }
}

function providerRejectedNormalizedImage(detail: string): boolean {
  const reasonBeforeImage = /(?:unsupported|invalid|cannot read|failed to (?:decode|process)).{0,40}image/iu;
  const imageBeforeReason = /image.{0,40}(?:unsupported|invalid|cannot be decoded)/iu;
  return reasonBeforeImage.test(detail) || imageBeforeReason.test(detail);
}

interface UsedRequestFile {
  version: RequestImageAttachment;
  fileId: DeepSeekFileId;
  location: ImageWireLocation;
}

function providerRejectedFileId(detail: string): boolean {
  const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/iu.test(detail);
  const missing = /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/iu.test(detail);
  const invalidId = /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/iu.test(detail);
  return file && (missing || invalidId);
}

function detailNamesFileId(detail: string, fileId: DeepSeekFileId): boolean {
  let index = detail.indexOf(fileId);
  while (index >= 0) {
    const before = detail[index - 1];
    const after = detail[index + fileId.length];
    if ((before === undefined || !/[\p{L}\p{N}_-]/u.test(before))
      && (after === undefined || !/[\p{L}\p{N}_-]/u.test(after))) return true;
    index = detail.indexOf(fileId, index + 1);
  }
  return false;
}

function staleMappings(
  files: readonly UsedRequestFile[],
  detail: string,
): UsedRequestFile[] {
  const unique = [...new Map(files.map(file => [file.version.variantId + '\0' + file.fileId, file])).values()];
  const exact = unique.filter(file => detailNamesFileId(detail, file.fileId));
  return exact.length > 0 ? exact : unique;
}

function normalizedImageFacts(
  file: { version: RequestImageAttachment; location: ImageWireLocation },
): string {
  const version = file.version;
  const name = version.attachment?.name ?? version.attachment?.attachmentId ?? version.variantId ?? 'image';
  const colour = version.hasAlpha === true ? 'sRGBA' : 'sRGB';
  return '"' + name + '" at message ' + file.location.message + ', image ' + file.location.image
    + ' (' + version.mediaType + ', 8-bit ' + colour + ', ' + (version.width ?? 0) + 'x' + (version.height ?? 0) + ')';
}

function normalizedImageDiagnostic(
  files: readonly UsedRequestFile[],
  providerMessage: string,
  providerDetail: string,
): string {
  const exact = files.find(file => detailNamesFileId(providerDetail, file.fileId));
  const target = exact ?? (files.length === 1 ? files[0] : undefined);
  if (target !== undefined) {
    return 'DeepSeek rejected normalized image ' + normalizedImageFacts(target) + ': ' + providerMessage + '. '
      + 'The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.';
  }
  const candidates = [...new Map(files.map(file => [
    file.version.variantId + '\0' + file.location.message + '\0' + file.location.image,
    file,
  ])).values()];
  return 'DeepSeek rejected a normalized request image: ' + providerMessage + '. Candidate images: '
    + candidates.map(normalizedImageFacts).join('; ') + '. '
    + 'The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.';
}

/** Files state owned by one model request, including at most one stale-id retry. */
export class RequestFiles {
  private used: UsedRequestFile[] = [];
  private retried = false;
  private readonly files: DeepSeekFileStore;
  private readonly connection: DeepSeekFileConnection;
  private readonly policy: DeepSeekFilePolicy;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal;
  private readonly activity: () => void;

  constructor(
    files: DeepSeekFileStore,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    timeoutMs: number,
    signal: AbortSignal,
    activity: () => void = () => {},
  ) {
    this.files = files;
    this.connection = connection;
    this.policy = policy;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.activity = activity;
  }

  /** Reset occurrence tracking before serializing the next HTTP attempt. */
  beginAttempt(): void { this.used = []; }

  /**
   * Resolve a retained image under its own upload deadline.
   * @param version - prepared request image.
   * @param location - occurrence used by provider-rejection diagnostics.
   * @returns the reusable provider id.
   */
  async resolve(version: RequestImageAttachment, location: ImageWireLocation): Promise<DeepSeekFileId> {
    requireUploadIdentity(version);
    const limit = deadlineSignal(this.signal, this.timeoutMs, 'DEEPSEEK_FILES_API_TIMEOUT');
    let resolved: DeepSeekFileReference;
    try {
      resolved = await this.files.ensureUploaded(version, this.connection, this.policy, limit.signal);
    } catch (error: unknown) {
      if (this.signal.aborted) throw error;
      throw new FileResolutionFailure(error);
    } finally {
      limit.clear();
    }
    this.activity();
    this.used.push({ version, fileId: resolved.record.fileId, location });
    return resolved.record.fileId;
  }

  /**
   * Invalidate rejected mappings; only the first stale-id response permits another request.
   * @param detail - provider error fields used for stale-id classification.
   * @returns whether the caller should serialize and dispatch again.
   */
  async retry(detail: string): Promise<boolean> {
    if (this.used.length === 0 || !providerRejectedFileId(detail)) return false;
    await Promise.all(staleMappings(this.used, detail).map(file => this.files.invalidate(file.version, file.fileId, this.connection)));
    if (this.retried) return false;
    this.retried = true;
    return true;
  }

  /**
   * Attribute a normalized-image rejection to the actual uploaded image occurrences.
   * @param status - rejected request's HTTP status.
   * @param message - provider's error message.
   * @param detail - provider error classification fields.
   * @returns the image diagnostic or the original provider message.
   */
  errorMessage(status: number, message: string, detail: string): string {
    return status === 400 && this.used.length > 0 && providerRejectedNormalizedImage(detail)
      ? normalizedImageDiagnostic(this.used, message, detail)
      : message;
  }
}
