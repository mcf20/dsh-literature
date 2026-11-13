/**
 * Elsevier full text through the official TDM API.
 *
 * The PDF that endpoint returns is often image-based, so text extraction is
 * poor; the same article is available as JATS XML (and plain text), which is
 * both complete and structured. Reading prefers that.
 * @module dsh-literature/elsevier
 */
import { request, userAgent } from './net.js';

const ARTICLE = 'https://api.elsevier.com/content/article/doi';

function decodeEntities(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&amp;/g, '&');
}

/** JATS/Elsevier XML → Markdown with section headings and paragraphs. */
export function xmlToMarkdown(xml) {
    if (typeof xml !== 'string' || xml.length === 0) return '';
    const bodyMatch = xml.match(/<ce:body[^>]*>([\s\S]*?)<\/ce:body>/i);
    let body = bodyMatch?.[1];
    if (!body) {
        // No <ce:body>: start at the abstract so the record header (URLs, DOIs,
        // author lists, copyright) does not become the first paragraph.
        const start = xml.search(/<ce:abstract|<ce:para|<ce:sections/i);
        body = start >= 0 ? xml.slice(start) : xml;
    }
    const withHeadings = body
        .replace(/<ce:section-title[^>]*>([\s\S]*?)<\/ce:section-title>/gi, (_match, title) => `\n\n## ${title}\n\n`)
        .replace(/<ce:label[^>]*>([\s\S]*?)<\/ce:label>/gi, '$1 ')
        .replace(/<ce:para[^>]*>/gi, '\n\n')
        .replace(/<\/ce:para>/gi, '\n\n')
        .replace(/<ce:simple-para[^>]*>/gi, '\n\n')
        .replace(/<\/ce:simple-para>/gi, '\n\n')
        .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, '\n\n## $1\n\n');
    const text = decodeEntities(withHeadings.replace(/<[^>]+>/g, ' '))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^ +| +$/gm, '')
        .trim();
    return text;
}

/**
 * Fetch one article's full text as Markdown.
 * @param doi - canonical DOI.
 * @param apiKey - Elsevier API key.
 * @param options - transport settings (timeouts, proxy routing).
 * @returns Markdown and source kind, or an error note.
 */
export async function fetchFullText(doi, apiKey, options = {}) {
    if (!doi) return { ok: false, error: 'no DOI' };
    if (!apiKey) return { ok: false, error: 'no Elsevier key' };
    const url = `${ARTICLE}/${encodeURIComponent(doi)}?httpAccept=${encodeURIComponent('text/xml')}`;
    const res = await request(url, {
        ...options,
        as: 'text',
        ua: userAgent(options.version),
        headers: { 'x-els-apikey': apiKey, accept: 'text/xml' },
        timeoutMs: options.timeoutMs ?? 60_000,
    });
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
    const markdown = xmlToMarkdown(res.data);
    if (markdown.length < 500) return { ok: false, error: `XML returned only ${markdown.length} characters` };
    return { ok: true, markdown, chars: markdown.length, kind: 'jats-xml' };
}
