/**
 * Local paper store: download, content-addressed cache, PDF text extraction,
 * a light Markdown structure pass, and full-text search over what was cached.
 * @module dsh-literature/store
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeDoi, titleKey } from './identity.js';
import { looksLikePdf, request, tidy } from './net.js';

const PDF_NAME = 'paper.pdf';
const MD_NAME = 'paper.md';
const META_NAME = 'meta.json';

/**
 * Absolute cache root. An empty config value means `~/.dsh-literature` — stable
 * across sessions, unlike the dsh process cwd, which is wherever the server
 * was launched from.
 */
export function resolveDataDir(configured) {
    if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim());
    return join(homedir(), '.dsh-literature');
}

/** Characters Windows forbids in a file name. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** A file name safe on Windows, macOS and Linux. */
export function safeFileName(text, limit = 150) {
    return String(text ?? '')
        .replace(ILLEGAL, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[. ]+|[. ]+$/g, '')
        .slice(0, limit)
        .trim();
}

/** First author's surname: "Nicole DeHoratius" → "DeHoratius", "Zhang, Zehong" → "Zhang". */
export function surnameOf(author) {
    const value = String(author ?? '').trim();
    if (value.length === 0) return '';
    if (value.includes(',')) return safeFileName(value.split(',')[0], 40);
    const parts = value.split(/\s+/);
    return safeFileName(parts[parts.length - 1], 40);
}

/**
 * The reading-list file name: `2020_N Engl J Med_Beck_Somatic Mutations.pdf`.
 * @param meta - year, venue, author, title.
 */
export function libraryFileName(meta) {
    const parts = [
        meta.year ?? '',
        meta.venue ?? '',
        surnameOf(meta.author),
        meta.title ?? meta.key ?? 'paper',
    ].map((part) => safeFileName(part, 120)).filter((part) => part.length > 0);
    const base = parts.join('_').slice(0, 180);
    return `${base || 'paper'}.pdf`;
}

/**
 * Copy the cached PDF into `<dataDir>/library/` under its readable name, so the
 * downloads are usable outside the plugin (Zotero, a supervisor, a reading list).
 * @returns the destination path, or undefined when the copy failed.
 */
export async function saveNamedCopy(dataDir, sourcePath, bytes, name) {
    const dir = join(dataDir, 'library');
    await mkdir(dir, { recursive: true });
    const target = join(dir, name);
    await writeFile(target, bytes);
    return target;
}

/** Stable short id for a paper: DOI, then arXiv id, then PMID, then title key. */
export function paperKey(record) {
    // Normalise here too: a caller may pass a raw `https://doi.org/…` string, and
    // the same paper must always land in the same cache directory.
    const doi = normalizeDoi(record.doi);
    const seed = doi
        ? `doi:${doi}`
        : record.arxivId
            ? `arxiv:${record.arxivId}`
            : record.pmid
                ? `pmid:${record.pmid}`
                : `title:${record.titleKey ?? titleKey(record.title) ?? 'unknown'}`;
    return createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

export function paperDir(dataDir, key) {
    return join(dataDir, 'papers', key);
}

async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}

/**
 * Download one URL and keep it only when the bytes really are a PDF.
 * Publishers answer 200 with a login page often enough to matter.
 * @param url - candidate PDF URL.
 * @param options - transport settings and size ceiling.
 */
export async function downloadPdf(url, options) {
    const res = await request(url, { ...options, as: 'bytes' });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, url };
    if (!looksLikePdf(res.data)) {
        return { ok: false, error: `not a PDF (content-type ${res.contentType || 'unknown'}); probably a landing or login page`, status: 0, url };
    }
    return {
        ok: true,
        bytes: res.data,
        length: res.data.byteLength,
        sha256: createHash('sha256').update(res.data).digest('hex'),
        finalUrl: res.finalUrl ?? url,
        contentType: res.contentType,
    };
}

/**
 * Content index of the library: sha256 → cache key.
 *
 * The same PDF can be reachable under two identifiers (a journal DOI whose
 * Unpaywall location is the arXiv copy), so identity by DOI alone would store the
 * file twice and list one paper as two.
 */
let shaIndex;

async function contentIndex(dataDir) {
    if (shaIndex && shaIndex.dir === dataDir) return shaIndex.map;
    const map = new Map();
    const byUrl = new Map();
    const root = join(dataDir, 'papers');
    try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const meta = await readJson(join(root, entry.name, META_NAME));
            if (meta?.sha256) map.set(meta.sha256, entry.name);
            const key = urlKey(meta?.sourceUrl);
            if (key) byUrl.set(key, entry.name);
        }
    }
    catch {
        // No library yet.
    }
    map.byUrl = byUrl;
    shaIndex = { dir: dataDir, map };
    return map;
}

/** Canonical form of a source URL, for the "have we already fetched this" index. */
function urlKey(url) {
    if (typeof url !== 'string' || url.length === 0) return undefined;
    try {
        const parsed = new URL(url);
        return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
    }
    catch {
        return undefined;
    }
}

/**
 * Which existing paper was fetched from this exact URL, if any. Checked before a
 * download so a second identifier pointing at the same file costs nothing.
 * @param dataDir - library root.
 * @param url - candidate download URL.
 */
export async function findByUrl(dataDir, url) {
    const wanted = urlKey(url);
    if (!wanted) return undefined;
    const map = await contentIndex(dataDir);
    return map.byUrl?.get(wanted);
}

/**
 * Find cached bytes for a paper whose content may already be stored under another
 * identifier, without downloading it first.
 * @param dataDir - library root.
 * @param urls - every candidate URL for the paper.
 */
export async function findAnyByUrl(dataDir, urls) {
    for (const url of urls ?? []) {
        const key = await findByUrl(dataDir, url);
        if (key) return key;
    }
    return undefined;
}

/** True when the same bytes are already stored under another key. */
export async function findBySha(dataDir, sha256) {
    if (!sha256) return undefined;
    const map = await contentIndex(dataDir);
    return map.get(sha256);
}

/**
 * Persist a downloaded paper. The PDF is written once; a second hit reuses it.
 * When the same bytes already exist under another identifier, only an alias is
 * recorded instead of a second copy.
 * @param dataDir - cache root.
 * @param key - paper key.
 * @param download - a successful {@link downloadPdf} result.
 * @param meta - caller metadata (title, doi, source url, license).
 */
export async function savePaper(dataDir, key, download, meta) {
    const holder = await findBySha(dataDir, download.sha256);
    if (holder && holder !== key) {
        const dir = paperDir(dataDir, holder);
        const existing = (await readJson(join(dir, META_NAME))) ?? {};
        const aliases = new Set(Array.isArray(existing.aliases) ? existing.aliases : []);
        aliases.add(key);
        if (meta?.doi) aliases.add(`doi:${meta.doi}`);
        if (meta?.arxivId) aliases.add(`arxiv:${meta.arxivId}`);
        const updated = { ...existing, aliases: [...aliases] };
        await writeFile(join(dir, META_NAME), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
        return {
            ...updated,
            key: holder,
            path: join(dir, PDF_NAME),
            bytes: existing.bytes,
            sha256: download.sha256,
            duplicateOf: holder,
        };
    }
    const dir = paperDir(dataDir, key);
    await mkdir(dir, { recursive: true });
    const path = join(dir, PDF_NAME);
    await writeFile(path, download.bytes);
    const existing = await readJson(join(dir, META_NAME));
    const record = {
        ...existing,
        ...meta,
        key,
        path,
        bytes: download.length,
        sha256: download.sha256,
        sourceUrl: download.finalUrl ?? download.url,
        savedAt: new Date().toISOString(),
    };
    await writeFile(join(dir, META_NAME), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    shaIndex = undefined;
    return record;
}

let pdfRuntime;

/** pdf-parse is loaded on first use so a plugin without PDF work stays light. */
async function pdfRuntimeModule() {
    if (!pdfRuntime) {
        // A rejection must not be cached: a missing dependency is often fixed by
        // installing it, and the module instance survives a plugin remount.
        pdfRuntime = import('pdf-parse').then((mod) => ({ PDFParse: mod.PDFParse }));
        pdfRuntime.catch(() => {
            pdfRuntime = undefined;
        });
    }
    return pdfRuntime;
}

/**
 * Extract raw text from PDF bytes.
 * @param data - PDF bytes.
 * @returns page count and concatenated text.
 */
export async function extractText(data) {
    const { PDFParse } = await pdfRuntimeModule();
    const pdf = new PDFParse({ data });
    try {
        const result = await pdf.getText();
        return { text: result.text ?? '', pages: result.total ?? 0 };
    }
    finally {
        await pdf.destroy().catch(() => undefined);
    }
}

const SECTION_WORDS = /^(abstract|introduction|background|related work|methods?|materials and methods|results?|discussion|conclusions?|limitations|references|bibliography|acknowledge?ments|appendix|supplementary)/i;
const NUMBERED_HEADING = /^\d+(\.\d+)*\.?\s+\S/;
const ALL_CAPS_HEADING = /^[A-Z][A-Z0-9 &\-:,]{5,80}$/;
const NOISE_LINE = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;

function isHeading(line) {
    if (line.length < 3 || line.length > 90) return false;
    if (/[.!?,;]$/.test(line)) return false;
    if (SECTION_WORDS.test(line)) return true;
    if (NUMBERED_HEADING.test(line) && line.split(/\s+/).length <= 12) return true;
    return ALL_CAPS_HEADING.test(line);
}

/**
 * Turn extracted PDF text into lightly structured Markdown. This is a heuristic
 * pass, not a layout model: it repairs hyphenation, drops running headers and
 * page numbers, marks headings, and keeps paragraphs.
 * @param text - raw extracted text.
 */
export function toMarkdown(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    const joined = text
        .replace(/\r\n?/g, '\n')
        .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
        .replace(/\u00ad/g, '');
    const lines = joined.split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim());
    const frequency = new Map();
    for (const line of lines) {
        if (line.length > 0 && line.length < 90) frequency.set(line, (frequency.get(line) ?? 0) + 1);
    }
    const out = [];
    let paragraph = [];
    const flush = () => {
        if (paragraph.length === 0) return;
        out.push(paragraph.join(' ').replace(/\s+/g, ' ').trim());
        paragraph = [];
    };
    for (const line of lines) {
        if (line.length === 0) {
            flush();
            continue;
        }
        if (NOISE_LINE.test(line)) continue;
        if ((frequency.get(line) ?? 0) >= 4 && line.length < 90) continue;
        if (isHeading(line)) {
            flush();
            out.push(`## ${line.replace(/^#+\s*/, '')}`);
            continue;
        }
        paragraph.push(line);
        if (out.length === 0) flush();
    }
    flush();
    return out
        .map((block) => (block.startsWith('## ') ? block : block.replace(/^\s+/, '')))
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Persist Markdown next to the PDF and record the page count.
 * @param dataDir - cache root.
 * @param key - paper key.
 * @param markdown - rendered Markdown.
 * @param pages - page count from the extractor.
 */
export async function saveMarkdown(dataDir, key, markdown, pages) {
    const dir = paperDir(dataDir, key);
    await mkdir(dir, { recursive: true });
    const path = join(dir, MD_NAME);
    await writeFile(path, `${markdown}\n`, 'utf8');
    const metaPath = join(dir, META_NAME);
    const meta = (await readJson(metaPath)) ?? {};
    await writeFile(metaPath, `${JSON.stringify({
        ...meta,
        pages,
        markdownPath: path,
        parsedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    return path;
}

/** Read a cached artifact, if present. */
export async function readCached(dataDir, key, kind = 'md') {
    const dir = paperDir(dataDir, key);
    const path = join(dir, kind === 'pdf' ? PDF_NAME : MD_NAME);
    try {
        const info = await stat(path);
        return { path, info };
    }
    catch {
        return undefined;
    }
}

/** Slice a long text with a stable offset so the model can page through it. */
export function sliceText(text, offset = 0, maxChars = 60_000) {
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.min(text.length, start + Math.max(1, maxChars));
    return { text: text.slice(start, end), offset: start, end, total: text.length, hasMore: end < text.length };
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Search every cached Markdown file.
 * @param dataDir - cache root.
 * @param query - literal text, or a regular expression when it compiles.
 * @param options - hit ceiling and context width.
 */
export async function searchLibrary(dataDir, query, options = {}) {
    const { limit = 20, context = 220 } = options;
    const root = join(dataDir, 'papers');
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return { scanned: 0, hits: [] };
    }
    let pattern;
    try {
        pattern = new RegExp(query, 'gi');
    }
    catch {
        pattern = new RegExp(escapeRegExp(query), 'gi');
    }
    const hits = [];
    let scanned = 0;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        let markdown;
        try {
            markdown = await readFile(join(dir, MD_NAME), 'utf8');
        }
        catch {
            continue;
        }
        scanned += 1;
        const meta = (await readJson(join(dir, META_NAME))) ?? {};
        let match;
        let found = 0;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(markdown)) !== null && found < 3) {
            found += 1;
            const start = Math.max(0, match.index - context);
            const end = Math.min(markdown.length, match.index + match[0].length + context);
            hits.push({
                key: entry.name,
                title: meta.title,
                doi: meta.doi,
                arxivId: meta.arxivId,
                year: meta.year,
                snippet: markdown.slice(start, end).replace(/\s+/g, ' ').trim(),
            });
            if (hits.length >= limit) return { scanned, hits };
        }
    }
    return { scanned, hits };
}

/** Cached papers, newest first. */
export async function listLibrary(dataDir, limit = 50) {
    const root = join(dataDir, 'papers');
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const rows = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = (await readJson(join(root, entry.name, META_NAME))) ?? {};
        rows.push({ key: entry.name, ...meta });
    }
    return rows
        .sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')))
        .slice(0, limit);
}

/** One-line description used in tool output. */
export function describeCandidate(entry, index) {
    const parts = [`${index + 1}. [${entry.source}] ${entry.url}`];
    if (entry.license) parts.push(entry.license);
    if (entry.version) parts.push(entry.version);
    return parts.join(' · ');
}

export { tidy };

