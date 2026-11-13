/**
 * Import PDFs the reader downloaded themselves.
 *
 * Some publishers (Nature, ACS, Wiley) hand a real browser a download instead of
 * a readable URL, so there is nothing to harvest. This module takes the file that
 * landed in the download folder and puts it through the same pipeline: identify
 * it, store it, parse it, and give it a readable name.
 * @module dsh-literature/import
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lookupTitleByDoi } from './fulltext.js';
import { titleKey } from './identity.js';
import { looksLikePdf } from './net.js';
import {
    extractText,
    libraryFileName,
    listLibrary,
    paperKey,
    saveMarkdown,
    saveNamedCopy,
    savePaper,
    toMarkdown,
} from './pdfstore.js';

/** The reader's download folder unless the config says otherwise. */
export function defaultImportDir() {
    return join(homedir(), 'Downloads');
}

/**
 * First DOI in the text. PDFs usually print it on the first page, in the header
 * or under the title.
 * @param text - extracted text.
 */
export function extractDoi(text) {
    if (typeof text !== 'string') return undefined;
    const match = text.slice(0, 20_000).match(/10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/);
    if (!match) return undefined;
    return match[0].replace(/[.,;:)\]}'"\s]+$/, '').toLowerCase();
}

function hashOf(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/** A title guess from the file name, for PDFs that carry no DOI. */
function titleFromName(name) {
    return name
        .replace(/\.pdf$/i, '')
        .replace(/[_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Scan a folder and import every PDF that is not already in the library.
 * @param options - source folder, library, transport for metadata, naming.
 * @returns one report row per file considered.
 */
export async function importPdfs(options) {
    const { dir, dataDir, transport, naming = 'pubmed', signal, limit = 50 } = options;
    const rows = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        return { rows: [], error: `无法读取目录 ${dir}：${error?.message ?? error}` };
    }
    const known = new Set((await listLibrary(dataDir, 500)).map((paper) => paper.sha256).filter(Boolean));
    const candidates = entries
        .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name) && !/^~\$/.test(entry.name))
        .slice(0, Math.max(1, limit));

    for (const entry of candidates) {
        if (signal?.aborted) break;
        const path = join(dir, entry.name);
        try {
            const info = await stat(path);
            if (info.size < 20_000) {
                rows.push({ file: entry.name, status: 'skipped', note: `太小（${Math.round(info.size / 1024)} KB）` });
                continue;
            }
            const bytes = await readFile(path);
            if (!looksLikePdf(bytes)) {
                rows.push({ file: entry.name, status: 'skipped', note: '不是 PDF' });
                continue;
            }
            const sha256 = hashOf(bytes);
            if (known.has(sha256)) {
                rows.push({ file: entry.name, status: 'duplicate', note: '库里已有同一文件' });
                continue;
            }
            const extracted = await extractText(bytes);
            const text = extracted.text ?? '';
            if (text.trim().length < 500) {
                rows.push({ file: entry.name, status: 'skipped', note: `文字层为空（${extracted.pages} 页，可能是扫描件）` });
                continue;
            }
            const doi = extractDoi(text);
            // A file with no DOI and a hash-like name is a browser artefact, not a
            // paper: refuse it rather than polluting the library.
            const stem = entry.name.replace(/\.pdf$/i, '').replace(/\s*\(\d+\)$/, '').trim();
            if (!doi && /^[0-9a-f]{16,}$/i.test(stem)) {
                rows.push({ file: entry.name, status: 'skipped', note: '无法识别：文件名是哈希且正文没有 DOI' });
                continue;
            }
            if (!doi && titleFromName(entry.name).length < 8) {
                rows.push({ file: entry.name, status: 'skipped', note: '无法识别：没有 DOI，文件名也看不出标题' });
                continue;
            }
            let meta = { title: titleFromName(entry.name), year: undefined, venue: undefined, author: undefined };
            if (doi) {
                const looked = await lookupTitleByDoi(doi, transport).catch(() => undefined);
                if (looked) {
                    meta = {
                        title: looked.title ?? meta.title,
                        year: looked.year,
                        venue: looked.venue,
                        author: looked.author,
                    };
                }
            }
            const identity = doi ? { doi } : { title: meta.title, titleKey: titleKey(meta.title) };
            const key = paperKey(identity);
            const saved = await savePaper(dataDir, key, {
                bytes,
                length: bytes.length,
                sha256,
                finalUrl: `file://${path}`,
            }, {
                ...meta,
                doi,
                license: 'institutional',
                via: 'manual-download',
                sourceFile: path,
            });
            const markdown = toMarkdown(text);
            if (saved.duplicateOf) {
                rows.push({ file: entry.name, status: 'duplicate', note: `库里已有同一文件（${saved.key}）` });
                continue;
            }
            await saveMarkdown(dataDir, key, markdown, extracted.pages);
            let namedPath = '';
            if (naming !== 'hash') {
                namedPath = await saveNamedCopy(dataDir, saved.path, bytes, libraryFileName({ ...meta, key }));
            }
            known.add(sha256);
            rows.push({
                file: entry.name,
                status: 'imported',
                doi,
                title: meta.title,
                pages: extracted.pages,
                chars: markdown.length,
                path: saved.path,
                namedPath,
            });
        }
        catch (error) {
            rows.push({ file: entry.name, status: 'failed', note: error?.message ?? String(error) });
        }
    }
    return { rows };
}

