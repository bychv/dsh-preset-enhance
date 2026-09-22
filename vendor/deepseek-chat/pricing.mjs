/**
 * Vendored from DeepSeek Harness, tag dsh-v0.1.6-alpha.2 (migration baseline):
 * packages/llm/llm-deepseek/src/common/request-pricing.ts and common/image-tokens.ts,
 * plus the attachment dimension helpers they call
 * (packages/attachment/attachment/src/request-projection.ts: requestImageDimensions,
 * longEdgeDimensions) and the text-only substitution text (packages/llm/llm/src/content.ts).
 * Upstream is MIT licensed; Copyright (c) DeepSeek. Adapted for DSH 0.1.7-alpha.1.
 */
import { offloadedImageText, requestImageHandleText } from './serialize.mjs';
/** Default bound on accumulated file-referenced image bytes per request. */
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024;
/** Provider request image-count limit. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600;
/** Total-pixel budget matching provider low-detail image input. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512;
/** Encoded-byte target for one deterministic request image. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Provider per-side limit for a request carrying 15 or more images. */
export const REQUEST_IMAGE_MAX_DIMENSION = 4096;
/** Vision patch edge in pixels. */
const PATCH_SIZE = 14;
/** Per-axis patch-to-token downsampling ratio. */
const DOWNSAMPLE_RATIO = 3;
/** Provider cap on tokens for one request image. */
const MAX_IMAGE_TOKENS = 1024;
/** Total-pixel floor; smaller images are scaled up before grid projection. */
const MIN_PIXELS = 544 * 544;
/** Pixels covered by one token cell along either axis. */
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;
const intDiv = (value, divisor) => Math.floor(value / divisor);
const ceilDiv = (value, divisor) => Math.floor((value + divisor - 1) / divisor);
/**
 * Aspect-preserving integer dimensions within a hard total-pixel budget; small
 * images are not enlarged (ported verbatim from the attachment package).
 */
export function requestImageDimensions(width, height, maxPixels) {
    const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
    if (scale === 1)
        return { width, height };
    if (width >= height) {
        let projectedWidth = Math.max(1, Math.floor(width * scale));
        let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
        while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
            projectedWidth -= 1;
            projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
        }
        return { width: projectedWidth, height: projectedHeight };
    }
    let projectedHeight = Math.max(1, Math.floor(height * scale));
    let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
    while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
        projectedHeight -= 1;
        projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
    }
    return { width: projectedWidth, height: projectedHeight };
}
/** Aspect-preserving dimensions with an exact long edge; never enlarges. */
export function longEdgeDimensions(width, height, longEdge) {
    if (longEdge >= Math.max(width, height))
        return { width, height };
    return width >= height
        ? { width: longEdge, height: Math.max(1, Math.round(longEdge * height / width)) }
        : { width: Math.max(1, Math.round(longEdge * width / height)), height: longEdge };
}
function gridTokens(gridHeight, gridWidth) {
    return gridHeight * (gridWidth + 1) + 2;
}
function gridCells(paddedLength) {
    return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO);
}
function solveResizeRatio(height, width, budget) {
    const aspect = height / width;
    const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5;
    const idealGridHeight = idealGridWidth * aspect;
    let bestHeight;
    let bestWidth;
    if (idealGridWidth < 1) {
        const solvedGridWidth = 1;
        const solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1);
        bestWidth = solvedGridWidth * CELL_SIZE;
        bestHeight = solvedGridHeight * CELL_SIZE;
    }
    else if (idealGridHeight < 1) {
        const solvedGridHeight = 1;
        const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1;
        bestWidth = solvedGridWidth * CELL_SIZE;
        bestHeight = solvedGridHeight * CELL_SIZE;
    }
    else {
        const solvedGridWidth = Math.trunc(idealGridWidth);
        const solvedGridHeight = Math.trunc(idealGridHeight);
        const scale = Math.min(solvedGridWidth * CELL_SIZE / width, solvedGridHeight * CELL_SIZE / height);
        bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE;
        bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE;
    }
    const gridHeight = gridCells(bestHeight);
    const gridWidth = gridCells(bestWidth);
    return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) };
}
function safeResize(height, width, paddedHeight, paddedWidth) {
    const gridHeight = gridCells(paddedHeight);
    const gridWidth = gridCells(paddedWidth);
    const direct = {
        gridHeight, gridWidth, bestHeight: paddedHeight, bestWidth: paddedWidth,
        numTokens: gridTokens(gridHeight, gridWidth),
    };
    if (direct.numTokens <= MAX_IMAGE_TOKENS)
        return direct;
    const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS);
    if (solved.numTokens > MAX_IMAGE_TOKENS) {
        throw new Error('deepseek image tokens: no grid fits the token budget for ' + width + 'x' + height);
    }
    return solved;
}
function resizeOnce(width, height) {
    let scaledWidth = width;
    let scaledHeight = height;
    const pixels = scaledWidth * scaledHeight;
    if (pixels < MIN_PIXELS && pixels > 0) {
        const scale = Math.sqrt(MIN_PIXELS / pixels);
        scaledWidth = Math.trunc(scaledWidth * scale);
        scaledHeight = Math.trunc(scaledHeight * scale);
    }
    const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
    const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
    return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth);
}
function sameResize(a, b) {
    return a.gridHeight === b.gridHeight && a.gridWidth === b.gridWidth
        && a.bestHeight === b.bestHeight && a.bestWidth === b.bestWidth && a.numTokens === b.numTokens;
}
/** Request dimensions DeepSeek keeps the whole image at (ported verbatim). */
export function deepSeekRequestImageDimensions(width, height) {
    const paddedWidth = ceilDiv(width, PATCH_SIZE) * PATCH_SIZE;
    const paddedHeight = ceilDiv(height, PATCH_SIZE) * PATCH_SIZE;
    if (gridTokens(gridCells(paddedHeight), gridCells(paddedWidth)) <= MAX_IMAGE_TOKENS)
        return { width, height };
    const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS);
    return longEdgeDimensions(width, height, width >= height ? solved.bestWidth : solved.bestHeight);
}
/** Vision tokens DeepSeek charges for one request image (at most 1024). */
export function deepSeekImageTokens(width, height) {
    let result = resizeOnce(width, height);
    for (let iteration = 1; iteration < 10; iteration += 1) {
        const next = resizeOnce(result.bestWidth, result.bestHeight);
        if (sameResize(next, result))
            return result.numTokens;
        result = next;
    }
    throw new Error('deepseek image tokens: resize did not converge for ' + width + 'x' + height);
}
/** Per-route encoded-byte target for every request image. */
export function resolveRequestImageMaxBytes(model) {
    return model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES;
}
/**
 * Deterministic request target for one source image: the published token grid
 * unless the model overrides it with a pixel budget, then the provider per-side
 * limit, then the route byte target. Small images are never enlarged.
 */
export function resolveRequestImageTarget(model, source) {
    const budget = model.imagePixelBudget === 'low' ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET : model.imagePixelBudget;
    const projected = budget === undefined
        ? deepSeekRequestImageDimensions(source.width, source.height)
        : requestImageDimensions(source.width, source.height, budget);
    const capped = Math.max(projected.width, projected.height) > REQUEST_IMAGE_MAX_DIMENSION
        ? longEdgeDimensions(source.width, source.height, REQUEST_IMAGE_MAX_DIMENSION)
        : projected;
    return { ...capped, maxBytes: resolveRequestImageMaxBytes(model) };
}
/** Deterministic text-only substitution for a route without the image modality. */
export function textOnlyImageText(ref) {
    const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8);
    return '[image omitted because this model accepts text only; attachment sha256:' + digest + ']';
}
/**
 * Request-image pricing for one route: offloaded occurrences price as their
 * placeholder text, retained ones by their projected request dimensions, and
 * every occurrence of a text-only or uncatalogued model as its text
 * substitution. Consumed synchronously by the host token meter.
 */
export function deepSeekImageRequestPricing(connection, model, resolveAccess) {
    const catalogModel = connection.models.find(entry => entry.id === model);
    if (catalogModel?.inputModalities?.includes('image') !== true) {
        return { priceImages: images => images.map((block) => ({ visualTokens: 0, text: textOnlyImageText(block.attachment) })) };
    }
    return {
        priceImages: images => images.map((block) => {
            const ref = block.attachment;
            if (block.offloaded === true)
                return { visualTokens: 0, text: offloadedImageText(ref, resolveAccess?.(ref)) };
            const target = resolveRequestImageTarget(catalogModel, { width: ref.width ?? 1, height: ref.height ?? 1, ...ref });
            return {
                visualTokens: deepSeekImageTokens(target.width, target.height),
                text: requestImageHandleText(ref, target, resolveAccess?.(ref)),
            };
        }),
    };
}
