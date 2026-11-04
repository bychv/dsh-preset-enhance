import { ADMIT_IMAGE_BATCH, contextFileEncoded, contextFileHash, contextFilesOf, decodeContextBase64, isPresetContextBlock } from './context-files.mjs';
/**
 * Turn compiled `preset-context` blocks into blocks an adapter can send: a host attachment
 * reference when admission is available, otherwise inline bytes for this plugin's adapter.
 * Bytes never enter the compiled result, so a cached per-session compilation stays small.
 */
export async function materializePresetContext(options) {
    const { preset, messages, assets, admission, allowInline } = options;
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
        // The host only accepts images in user/tool messages: its Messages serializer throws
        // UNSUPPORTED_CONTENT and the chat serializer degrades the image to a text placeholder. A
        // preset that predates the rule (or a hand-edited state file) must not break the request.
        if (message.role !== 'user') {
            warnings.push('注入消息 ' + (message.id ?? '(未知)') + ' 的角色是 ' + String(message.role) +
                '，上下文文件已跳过：宿主只接受 user 消息中的图片');
            out.push({ ...message, content: blocks.filter(block => !isPresetContextBlock(block)) });
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
                const ref = await admitFile(encoded, file.name, admission, warnings, block.identifier);
                if (ref === null)
                    continue;
                fileCount += 1;
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
                // Admission was unavailable or refused. Our own adapter can still upload the bytes: hand it
                // a synthetic content-addressed identity plus the payload, exactly like a user attachment.
                if (allowInline === true) {
                    const bytes = decodeContextBase64(part.data);
                    // Same shape the host uses for its own attachments, so the Files upload index accepts it.
                    const identity = 'sha256:' + contextFileHash(bytes);
                    cleaned.push({ type: 'image', attachment: { attachmentId: identity },
                        mediaType: part.mediaType, presetData: part.data,
                        ...(part.name === undefined ? {} : { name: part.name }) });
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
        // Admission accepts prompt input, not reasoning or tool blocks. Preserve all other
        // blocks verbatim while batching images together for the host's per-message limits.
        const images = parts.filter((part) => part.type === 'image');
        if (images.length > ADMIT_IMAGE_BATCH) {
            warnings.push('一条消息的上下文图片 ' + images.length + ' 张超过入库批量 ' + ADMIT_IMAGE_BATCH + ' 张，将分批入库');
        }
        // The host validates images per message: admitting 21+ at once is rejected as a batch, which
        // would drop every image of that message. Split the call instead.
        const admitted = [];
        for (let start = 0; start < images.length; start += ADMIT_IMAGE_BATCH) {
            const batch = images.slice(start, start + ADMIT_IMAGE_BATCH);
            const result = await admission.admitPromptContent(batch.map((part) => {
                const { __presetIdentifier: _ignored, ...rest } = part;
                return rest;
            }));
            admitted.push(...result);
        }
        if (admitted.length !== images.length || admitted.some(part => part.type !== 'image' || !part.attachment)) {
            throw new Error('附件服务返回的图片数量或类型不匹配');
        }
        let index = 0;
        return parts.map(part => part.type === 'image' ? admitted[index++] : part);
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
