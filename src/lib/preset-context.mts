import { contextFileEncoded, contextFileHash, contextFilesOf, decodeContextBase64, isPresetContextBlock } from './context-files.mjs';
import type { ContentBlock, HostMessage, SillyTavernPreset } from './types.mjs';

/** The slice of the host attachment service this module needs. */
export interface ContextAdmission {
  /** Replace encoded images with durable references for one whole prompt. */
  admitPromptContent?(parts: readonly unknown[]): Promise<readonly ContextPart[]>;
  /** Store one encoded file and return its durable reference. */
  admitEncodedFile?(input: { data: string; name?: string }): Promise<ContextPartRef>;
}

interface ContextPartRef { attachmentId?: string; [key: string]: unknown }
interface ContextPart { type?: string; data?: string; attachment?: ContextPartRef; __presetIdentifier?: string; [key: string]: unknown }

export interface MaterializeContextOptions {
  preset: SillyTavernPreset;
  messages: readonly HostMessage[];
  /** Share-package assets keyed by sha256, for entries that reference them. */
  assets?: Readonly<Record<string, { data?: string }>>;
  admission?: ContextAdmission;
  /**
   * Whether bytes may travel inline on the block. Only this plugin's own chat adapter can turn
   * them into an upload; the official adapter resolves images through a host reference only.
   */
  allowInline?: boolean;
}

export interface MaterializeContextOutcome {
  messages: HostMessage[];
  warnings: string[];
  /** Images this preset injected (history images are not counted: the host keeps handling those). */
  imageCount: number;
  fileCount: number;
}

/**
 * Turn compiled `preset-context` blocks into blocks an adapter can send: a host attachment
 * reference when admission is available, otherwise inline bytes for this plugin's adapter.
 * Bytes never enter the compiled result, so a cached per-session compilation stays small.
 */
export async function materializePresetContext(options: MaterializeContextOptions): Promise<MaterializeContextOutcome> {
  const { preset, messages, assets, admission, allowInline } = options;
  const warnings: string[] = [];
  const prompts = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt] as const));
  const out: HostMessage[] = [];
  let imageCount = 0;
  let fileCount = 0;

  for (const message of messages) {
    const blocks = message.content ?? [];
    if (!blocks.some(block => isPresetContextBlock(block))) {
      out.push(message);
      continue;
    }
    const parts: ContentBlock[] = [];
    let presetImages = 0;
    let skippedImages = 0;
    for (const block of blocks) {
      if (!isPresetContextBlock(block)) { parts.push(block); continue; }
      const files = contextFilesOf(prompts.get(block.identifier));
      const file = files[block.index];
      if (file === undefined) {
        warnings.push('预设条目 ' + block.identifier + ' 的第 ' + (block.index + 1) + ' 个上下文文件已不存在，已跳过');
        continue;
      }
      if (file.kind !== block.kind || file.mediaType !== block.mediaType) {
        warnings.push('预设条目 ' + block.identifier + ' 的上下文文件类型已变化，已跳过');
        continue;
      }
      const encoded = contextFileEncoded(file, assets);
      if (encoded === null) { warnings.push('预设条目 ' + block.identifier + ' 的上下文文件缺少字节，已跳过'); continue; }
      // Only these counters decide the model-modality check: images that were already in the
      // conversation keep the host's own handling.
      // Identity is content-addressed by the attachment service, so a duplicate display name is
      // harmless and is passed through untouched, exactly like a user attachment.
      if (file.kind === 'file') {
        const ref = await admitFile(encoded, file.name, admission, warnings, block.identifier);
        if (ref === null) continue;
        fileCount += 1;
        parts.push({ type: 'file', attachment: ref } as ContentBlock);
        continue;
      }
      presetImages += 1;
      const marked: ContextPart = { type: 'image', data: encoded, mediaType: file.mediaType, __presetIdentifier: block.identifier,
        ...(file.name === undefined ? {} : { name: file.name }) };
      parts.push(marked as ContentBlock);
    }
    const admitted = admission?.admitPromptContent === undefined
      ? (parts as unknown as readonly ContextPart[])
      : await admitImages(parts, admission, warnings);
    const cleaned: ContentBlock[] = [];
    for (const part of admitted) {
      if (part.type === 'image' && typeof part.data === 'string') {
        // Admission was unavailable or refused. Our own adapter can still upload the bytes: hand it
        // a synthetic content-addressed identity plus the payload, exactly like a user attachment.
        if (allowInline === true) {
          const bytes = decodeContextBase64(part.data);
          const identity = 'preset:' + contextFileHash(bytes);
          cleaned.push({ type: 'image', attachment: { attachmentId: identity },
            mediaType: part.mediaType, presetData: part.data,
            ...(part.name === undefined ? {} : { name: part.name }) } as ContentBlock);
          continue;
        }
        warnings.push('预设条目 ' + (part.__presetIdentifier ?? '(未知)') + ' 的图片无法入库，本次请求已跳过该图片');
        skippedImages += 1;
        continue;
      }
      const { __presetIdentifier: _ignored, ...rest } = part;
      if (rest.type === 'image' && typeof rest.data === 'string') {
        // Inline fallback already counted above.
      }
      cleaned.push(rest as ContentBlock);
    }
    // Only images that actually reach the request count towards the modality check.
    imageCount += presetImages - skippedImages;
    if (cleaned.length === 0) {
      warnings.push('注入消息 ' + (message.id ?? '(未知)') + ' 没有可发送内容，已省略该消息');
      continue;
    }
    out.push({ ...message, content: cleaned });
  }
  return { messages: out, warnings, imageCount, fileCount };
}

/** Admit every encoded image of one prompt in a single batched call. */
async function admitImages(parts: ContentBlock[], admission: ContextAdmission, warnings: string[]): Promise<readonly ContextPart[]> {
  const hasEncoded = parts.some((part: any) => part.type === 'image' && typeof part.data === 'string');
  if (!hasEncoded) return parts as unknown as readonly ContextPart[];
  try {
    // Admission accepts prompt input, not reasoning or tool blocks. Preserve all other
    // blocks verbatim while batching images together for the host's per-message limits.
    const images = parts.filter((part: any) => part.type === 'image');
    const admitted = await admission.admitPromptContent!(images.map((part: any) => {
      const { __presetIdentifier: _ignored, ...rest } = part;
      return rest;
    }));
    if (admitted.length !== images.length || admitted.some(part => part.type !== 'image' || !part.attachment)) {
      throw new Error('附件服务返回的图片数量或类型不匹配');
    }
    let index = 0;
    return parts.map(part => part.type === 'image' ? admitted[index++] : part as ContextPart);
  } catch (error) {
    warnings.push('预设上下文图片入库失败：' + (error instanceof Error ? error.message : String(error)));
    return parts as unknown as readonly ContextPart[];
  }
}

/** Store one encoded file through the attachment service. */
async function admitFile(
  data: string, name: string | undefined, admission: ContextAdmission | undefined, warnings: string[], identifier: string,
): Promise<ContextPartRef | null> {
  if (admission?.admitEncodedFile === undefined) {
    warnings.push('预设条目 ' + identifier + ' 的文件无法入库，已跳过');
    return null;
  }
  try {
    return await admission.admitEncodedFile({ data, ...(name === undefined ? {} : { name }) });
  } catch (error) {
    warnings.push('预设条目 ' + identifier + ' 的文件入库失败：' + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}
