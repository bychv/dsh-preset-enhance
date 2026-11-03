import { contextFileEncoded, contextFilesOf, isPresetContextBlock } from './context-files.mjs';
/**
 * Turn compiled `preset-context` blocks into blocks an adapter can send: a host attachment
 * reference when admission is available, otherwise inline bytes for this plugin's adapter.
 * Bytes never enter the compiled result, so a cached per-session compilation stays small.
 */
export async function materializePresetContext(options) {
    const { preset, messages, assets, admission } = options;
    const warnings = [];
    const prompts = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt]));
    const out = [];
    let imageCount = 0;
    let fileCount = 0;
    for (const message of messages) {
        const blocks = message.content ?? [];
        if (!blocks.some(block => isPresetContextBlock(block))) {
            out.push(message);
            continue;
        }
        const parts = [];
        let presetImages = 0;
        let skippedImages = 0;
        for (const block of blocks) {
            if (!isPresetContextBlock(block)) {
                parts.push(block);
                continue;
            }
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
            if (encoded === null) {
                warnings.push('预设条目 ' + block.identifier + ' 的上下文文件缺少字节，已跳过');
                continue;
            }
            // Only these counters decide the model-modality check: images that were already in the
            // conversation keep the host's own handling.
            // Identity is content-addressed by the attachment service, so a duplicate display name is
            // harmless and is passed through untouched, exactly like a user attachment.
            if (file.kind === 'file') {
                fileCount += 1;
                const ref = await admitFile(encoded, file.name, admission, warnings, block.identifier);
                if (ref === null)
                    continue;
                parts.push({ type: 'file', attachment: ref });
                continue;
            }
            presetImages += 1;
            const marked = { type: 'image', data: encoded, mediaType: file.mediaType, __presetIdentifier: block.identifier,
                ...(file.name === undefined ? {} : { name: file.name }) };
            parts.push(marked);
        }
        const admitted = admission?.admitPromptContent === undefined
            ? parts
            : await admitImages(parts, admission, warnings);
        const cleaned = [];
        for (const part of admitted) {
            if (part.type === 'image' && typeof part.data === 'string') {
                // Admission was unavailable or refused. The serializer resolves images through a host
                // attachment reference only, so bytes cannot be embedded inline yet: skip and say so.
                warnings.push('预设条目 ' + (part.__presetIdentifier ?? '(未知)') + ' 的图片无法入库，本次请求已跳过该图片');
                skippedImages += 1;
                continue;
            }
            const { __presetIdentifier: _ignored, ...rest } = part;
            if (rest.type === 'image' && typeof rest.data === 'string') {
                // Inline fallback already counted above.
            }
            cleaned.push(rest);
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
async function admitImages(parts, admission, warnings) {
    const hasEncoded = parts.some((part) => part.type === 'image' && typeof part.data === 'string');
    if (!hasEncoded)
        return parts;
    try {
        return await admission.admitPromptContent(parts.map((part) => {
            const { __presetIdentifier: _ignored, ...rest } = part;
            return rest;
        }));
    }
    catch (error) {
        warnings.push('预设上下文图片入库失败：' + (error instanceof Error ? error.message : String(error)));
        return parts;
    }
}
/** Store one encoded file through the attachment service. */
async function admitFile(data, name, admission, warnings, identifier) {
    if (admission?.admitEncodedFile === undefined) {
        warnings.push('预设条目 ' + identifier + ' 的文件无法入库，已跳过');
        return null;
    }
    try {
        return await admission.admitEncodedFile({ data, ...(name === undefined ? {} : { name }) });
    }
    catch (error) {
        warnings.push('预设条目 ' + identifier + ' 的文件入库失败：' + (error instanceof Error ? error.message : String(error)));
        return null;
    }
}
