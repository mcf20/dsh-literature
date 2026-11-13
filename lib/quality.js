/**
 * Completeness rules for a downloaded document.
 *
 * A publisher can answer with a one-page preview while the article stays behind a
 * subscription, so "we got a PDF" is not the same as "we got the article". These
 * rules are pure so they can be tested without a network.
 * @module dsh-literature/quality
 */

/** Pages and characters a real article exceeds; below both, it is a preview. */
export const PREVIEW_MAX_PAGES = 1;
export const PREVIEW_MAX_CHARS = 8_000;

/**
 * Whether a parsed document is only a preview.
 * @param probe - `{ pages, markdown }` from the download inspection step.
 */
export function isPreviewProbe(probe) {
    const pages = Number(probe?.pages ?? 0);
    const chars = typeof probe?.markdown === 'string' ? probe.markdown.length : 0;
    return pages <= PREVIEW_MAX_PAGES && chars < PREVIEW_MAX_CHARS;
}
