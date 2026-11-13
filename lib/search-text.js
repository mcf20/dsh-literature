/**
 * Locate passages inside one paper's text.
 *
 * Reading a 60-page review slice by slice is slow when you only need one
 * sentence ("what learning rate did they use"). This finds the matches and
 * returns each with surrounding context, so a question can be answered from the
 * passage instead of from the whole document.
 * @module dsh-literature/search-text
 */

/**
 * Find every match of a literal string or a regular expression.
 * @param text - the document body.
 * @param query - literal text, or a pattern that compiles as a regular expression.
 * @param options - match limit and context width in characters.
 * @returns matches with offsets and surrounding context, in document order.
 */
export function findInText(text, query, options = {}) {
    const { limit = 5, context = 320 } = options;
    if (typeof text !== 'string' || text.length === 0) return { matches: [], total: 0, mode: 'literal' };
    const needle = typeof query === 'string' ? query.trim() : '';
    if (needle.length === 0) return { matches: [], total: 0, mode: 'literal' };

    let pattern;
    let mode = 'regex';
    try {
        pattern = new RegExp(needle, 'gi');
    }
    catch {
        // Not a valid pattern (a normal sentence): treat it as literal text.
        mode = 'literal';
        pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    const matches = [];
    let total = 0;
    let hit;
    // Guard against zero-length matches looping forever.
    let guard = 0;
    while ((hit = pattern.exec(text)) !== null && guard < 10_000) {
        guard += 1;
        total += 1;
        if (matches.length < limit) {
            const start = Math.max(0, hit.index - context);
            const end = Math.min(text.length, hit.index + hit[0].length + context);
            matches.push({
                offset: hit.index,
                matched: hit[0],
                before: text.slice(start, hit.index).replace(/\s+/g, ' ').trim(),
                after: text.slice(hit.index + hit[0].length, end).replace(/\s+/g, ' ').trim(),
            });
        }
        if (hit[0].length === 0) pattern.lastIndex += 1;
        if (total >= 200) break;
    }
    return { matches, total, mode };
}

/**
 * Render matches as readable passages.
 * @param matches - output of {@link findInText}.
 * @param query - the original query, echoed in the heading.
 */
export function formatMatches(matches, query) {
    if (matches.length === 0) return `正文里没有匹配「${query}」的内容。`;
    return [
        `共 ${matches.length} 处命中「${query}」`,
        '',
        ...matches.map((match, index) => [
            `**${index + 1}. 位置 ${match.offset}**`,
            `${match.before} **${match.matched}** ${match.after}`.trim(),
            '',
        ].join('\n')),
    ].join('\n').trim();
}
