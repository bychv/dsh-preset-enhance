import { createHash } from 'node:crypto';
/** Media types the preset editor accepts. Anything else is refused at import time. */
export const CONTEXT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const CONTEXT_FILE_TYPES = ['application/pdf', 'text/plain', 'application/json'];
/** One context file may not exceed this many decoded bytes. */
export const MAX_CONTEXT_FILE_BYTES = 8 * 1024 * 1024;
/**
 * Compiled content block that still has to be materialized before the request leaves
 * the plugin. It carries only identity, so the compiled result stays small enough to
 * cache per session without duplicating the bytes already stored in the preset.
 */
export const PRESET_CONTEXT_BLOCK = 'preset-context';
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function contextFileBytes(bytes) {
    return Buffer.from(bytes).toString('base64');
}
export function decodeContextBase64(data) {
    return new Uint8Array(Buffer.from(data, 'base64'));
}
export function contextFileHash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
/** Bytes for one context file: its own `data`, or the asset the caller resolved for it. */
export function contextFileEncoded(file, assets) {
    if (typeof file.data === 'string')
        return file.data;
    if (typeof file.asset === 'string') {
        const data = assets?.[file.asset]?.data;
        if (typeof data === 'string')
            return data;
    }
    return null;
}
/**
 * Validate one untrusted `contextFile`. The compiler and the request path both rely on
 * these invariants, so a malformed entry fails the import instead of producing a half
 * materialized request.
 */
export function validateContextFile(value, label) {
    if (value === undefined)
        return;
    if (!isRecord(value))
        throw new Error(label + '的 contextFile 必须是对象');
    const kind = value.kind;
    if (kind !== 'image' && kind !== 'file')
        throw new Error(label + '的 contextFile.kind 必须是 image 或 file');
    const mediaType = value.mediaType;
    if (typeof mediaType !== 'string' || !mediaType)
        throw new Error(label + '的 contextFile.mediaType 必须是文本');
    const allowed = kind === 'image' ? CONTEXT_IMAGE_TYPES : CONTEXT_FILE_TYPES;
    if (!allowed.includes(mediaType)) {
        throw new Error(label + ' 不支持的类型：' + mediaType + '（允许 ' + allowed.join('、') + '）');
    }
    const data = value.data;
    const asset = value.asset;
    const attachmentId = value.attachmentId;
    if (data === undefined && asset === undefined && attachmentId === undefined) {
        throw new Error(label + '的 contextFile 需要 data、asset 或 attachmentId 之一');
    }
    if (data !== undefined) {
        if (typeof data !== 'string' || !CANONICAL_BASE64.test(data))
            throw new Error(label + '的 contextFile.data 必须是规范 base64');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length === 0)
            throw new Error(label + '的 contextFile.data 不能为空');
        if (bytes.length > MAX_CONTEXT_FILE_BYTES)
            throw new Error(label + '的 contextFile 超过 ' + (MAX_CONTEXT_FILE_BYTES / 1024 / 1024) + ' MB 上限');
    }
    if (asset !== undefined && (typeof asset !== 'string' || !SHA256_HEX.test(asset)))
        throw new Error(label + '的 contextFile.asset 必须是 sha256');
    if (attachmentId !== undefined && (typeof attachmentId !== 'string' || !attachmentId || attachmentId.length > 200)) {
        throw new Error(label + '的 contextFile.attachmentId 无效');
    }
    if (value.name !== undefined && (typeof value.name !== 'string' || !value.name || value.name.length > 200))
        throw new Error(label + '的 contextFile.name 无效');
    for (const key of ['width', 'height']) {
        const size = value[key];
        if (size !== undefined && (!Number.isInteger(size) || size <= 0 || size > 100_000))
            throw new Error(label + '的 contextFile.' + key + ' 无效');
    }
}
/** True when the block only exists to carry a preset context file. */
export function isPresetContextBlock(block) {
    if (!isRecord(block) || block.type !== PRESET_CONTEXT_BLOCK)
        return false;
    return typeof block.identifier === 'string' && (block.kind === 'image' || block.kind === 'file') && typeof block.mediaType === 'string';
}
