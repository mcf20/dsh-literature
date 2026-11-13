/**
 * dsh-literature — literature search that reaches full text.
 *
 * Host half: five tools on `ctx.tools`, one system-prompt section, and a
 * per-call credential lookup for optional keys (CORE). Everything a user may
 * want to change is a Config field with a default.
 * @module dsh-literature
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { bskReady, downloadViaBsk } from './bsk.js';
import { isPreviewProbe } from './quality.js';
import { findInText, formatMatches } from './search-text.js';
import {
    downloadViaChromeFile,
    ensureBrowser,
    ensurePdfDownloadPref,
    extractPdfLinks,
    fetchViaBrowser,
    findChrome,
    harvestAssetUrl,
    openForLogin,
    sessionStatus,
    warmupFor,
} from './browser.js';
import { fetchFullText as fetchElsevierFullText } from './elsevier.js';
import { defaultImportDir, importPdfs } from './import.js';
import { fetchViaArticlePage } from './browser-click.js';
import { buildXlsx } from './xlsx.js';
import { dedupeWorks, normalizeDoi, rankWorks, titleKey } from './identity.js';
import { lookupTitleByDoi, resolveFulltext } from './fulltext.js';
import { BROWSER_UA, looksLikePdf, resolveProxy } from './net.js';
import { SOURCES, SOURCE_CAP, lookupArxivMeta, lookupTitleByPmid, resolveJournal, searchAll } from './sources.js';
import {
    describeCandidate,
    downloadPdf,
    extractText,
    findAnyByUrl,
    libraryFileName,
    listLibrary,
    paperKey,
    readCached,
    resolveDataDir,
    saveMarkdown,
    saveNamedCopy,
    savePaper,
    searchLibrary,
    sliceText,
    toMarkdown,
} from './pdfstore.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'literature';
/** `tools` is the only hard requirement; `systemPrompt` and `credentials` are optional. */
export const inject = ['tools', 'systemPrompt'];

const manifest = createRequire(import.meta.url)('../package.json');
export const VERSION = manifest.version;

const DAY = 24 * 60 * 60 * 1000;

export const Config = Schema.object({
    dataDir: Schema.string().default('').description('Cache directory for PDFs and Markdown; empty means ~/.dsh-literature.'),
    openalexMailto: Schema.string().default('').description('Contact address for the OpenAlex and Crossref polite pools.'),
    unpaywallEmail: Schema.string().default('').description('Contact address for Unpaywall; falls back to openalexMailto.'),
    coreApiKeyEnv: Schema.string().default('CORE_API_KEY').description('Credential reference holding a CORE API key (optional).'),
    semanticScholarApiKeyEnv: Schema.string().default('SEMANTIC_SCHOLAR_API_KEY').description('Credential reference holding a Semantic Scholar API key (optional; raises the rate limit).'),
    pubmedApiKeyEnv: Schema.string().default('NCBI_API_KEY').description('Credential reference holding an NCBI E-utilities API key (optional; 3 -> 10 requests/second).'),
    openalexApiKeyEnv: Schema.string().default('OPENALEX_API_KEY').description('Credential reference holding a free OpenAlex API key (needed once the shared per-IP daily budget is spent).'),
    elsevierApiKeyEnv: Schema.string().default('ELSEVIER_API_KEY').description('Credential reference holding an Elsevier API key; the official TDM endpoint serves entitled publisher PDFs without any scraping.'),
    proxyUrl: Schema.string().default('').description('HTTP proxy for outbound requests, e.g. http://127.0.0.1:7890. Empty means: HTTPS_PROXY/HTTP_PROXY, else the Windows system proxy.'),
    institutionalProxyUrl: Schema.string().default('').description('HTTP proxy whose egress carries your campus/corporate subscription; used only for publisher hosts. Use "direct" when this machine is already on campus.'),
    ezproxyPrefix: Schema.string().default('').description('EZproxy login prefix, e.g. https://ezproxy.example.edu/login?url= — publisher links are rewritten through it.'),
    browserDownload: Schema.boolean().default(true).description('Fetch PDFs through the local Chrome when a plain HTTP request is refused (publisher and PMC bot walls).'),
    chromePath: Schema.string().default('').description('Chrome executable; empty means auto-detect.'),
    cdpPort: Schema.natural().min(1024).max(65_535).default(9222).description('DevTools port used to drive that Chrome.'),
    chromeProfileDir: Schema.string().default('').description('Profile for the download browser; empty means ~/.dsh-literature/chrome, kept separate from your own.'),
    browserDirect: Schema.boolean().default(true).description('Launch that Chrome without the system proxy, so the egress IP is the campus one that carries the subscription.'),
    browserEngine: Schema.union(['auto', 'cdp', 'bsk']).default('auto').description('auto = the plugin Chrome first, then the bsk CLI for pages that need your signed-in browser; cdp = plugin Chrome only; bsk = bsk first.'),
    bskPath: Schema.string().default('bsk').description('Path to the browser-skill CLI; empty or "bsk" means resolve from PATH.'),
    importDir: Schema.string().default('').description('Folder lit_import scans for PDFs you downloaded yourself; empty means your Downloads folder.'),
    defaultSources: Schema.array(Schema.union([...SOURCES])).min(1).default([...SOURCES]).description('Platforms lit_search queries when the model names none; all five by default.'),
    maxPerSource: Schema.natural().min(1).max(50).default(10).description('Results per platform when the model omits max_per_source.'),
    abstractMaxChars: Schema.natural().default(600).description('Abstract characters shown per paper; 0 omits abstracts.'),
    readMaxChars: Schema.natural().min(1000).default(60_000).description('Characters returned per lit_read call by default.'),
    requestTimeoutMs: Schema.number().default(30_000).description('Per-request timeout (ms) for metadata calls.'),
    pdfTimeoutMs: Schema.number().default(150_000).description('Per-request timeout (ms) for PDF downloads.'),
    humanWaitMs: Schema.natural().default(20_000).description('How long an article-page download waits for you to clear a bot challenge before giving up (ms).'),
    maxRetries: Schema.number().default(3).description('Attempts for retryable HTTP failures.'),
    toolTimeoutMs: Schema.number().default(180_000).description('Cooperative per-call budget (ms).'),
    promptGuidance: Schema.boolean().default(true).description('Register the system-prompt guidance section.'),
    promptOrder: Schema.number().default(160).description('Order of that section within the assembled prompt.'),
});

/**
 * Resolve an optional credential reference through the credentials service,
 * falling back to the launching environment.
 * @param ctx - plugin context.
 * @param ref - credential reference name.
 */
async function credentialValue(ctx, ref) {
    if (typeof ref !== 'string' || ref.length === 0) return undefined;
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (credentials) {
        try {
            const hit = await credentials.resolve(ref);
            if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value;
        }
        catch {
            // A deployment without the reference simply has no key.
        }
    }
    const ambient = process.env[ref];
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined;
}

function transportOf(config) {
    return {
        version: VERSION,
        timeoutMs: config.requestTimeoutMs,
        retries: config.maxRetries,
        proxy: config.proxyUrl,
        institutionalProxy: config.institutionalProxyUrl,
        ezproxyPrefix: config.ezproxyPrefix,
    };
}

function clip(value, limit) {
    if (typeof value !== 'string') return '';
    if (limit <= 0) return '';
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Human label for whether this record's full text is reachable. */
function reachLabel(record) {
    if (record.arxivId) return 'arXiv PDF';
    if (record.pmcid) return 'PMC';
    if (record.oa?.pdfUrls?.length) return `OA PDF (${record.oa.status})`;
    return 'metadata only';
}

function renderSearch({ query, works, perSource, failures, config, scope, exportPath }) {
    const lines = [`## ${query}`, ''];
    if (scope) lines.push(`期刊范围：${scope}`, '');
    const reachable = works.filter((record) => reachLabel(record) !== 'metadata only').length;
    lines.push(`去重后 ${works.length} 篇 · 可直接取全文 ${reachable} 篇 · 来源 ${perSource.map((entry) => `${entry.source} ${entry.count}`).join(' / ')}`, '');
    works.forEach((record, index) => {
        const cite = [record.volume ? `卷 ${record.volume}` : '', record.issue ? `期 ${record.issue}` : '', record.pages ?? ''].filter(Boolean).join(' · ');
        const head = [record.title ?? '(untitled)', record.year ? `(${record.year})` : '', record.venue ? `· ${record.venue}` : '', cite ? `[${cite}]` : ''].filter(Boolean).join(' ');
        lines.push(`**${index + 1}. ${head}**`);
        if (record.authors?.length) lines.push(`作者：${record.authors.slice(0, 4).join(', ')}${record.authors.length > 4 ? ' 等' : ''}`);
        const ids = [];
        if (record.doi) ids.push(`DOI ${record.doi}`);
        if (record.arxivId) ids.push(`arXiv ${record.arxivId}`);
        if (record.pmid) ids.push(`PMID ${record.pmid}`);
        if (record.pmcid) ids.push(record.pmcid);
        if (ids.length) lines.push(ids.join(' · '));
        const meta = [`全文：${reachLabel(record)}`];
        if (record.citedBy !== undefined) meta.push(`被引 ${record.citedBy}`);
        meta.push(`命中 ${record.sources.join('+')}`);
        lines.push(meta.join(' · '));
        const abstract = clip(record.abstract, config.abstractMaxChars);
        if (abstract) lines.push(`摘要：${abstract}`);
        lines.push('');
    });
    if (failures.length) lines.push('部分来源失败：', ...failures.map((entry) => `- ${entry.source}: ${entry.error}`));
    if (exportPath) lines.push('', `已导出表格：${exportPath}`);
    return lines.join('\n').trim();
}

/** One worksheet row per paper, for the XLSX export. */
function exportRows(works) {
    const header = ['标题', '作者', '期刊', '年份', '卷', '期', '页码', 'DOI', 'arXiv', 'PMID', '被引', '全文可得', '来源'];
    const rows = works.map((record) => [
        record.title ?? '',
        (record.authors ?? []).join('; '),
        record.venue ?? '',
        record.year ?? '',
        record.volume ?? '',
        record.issue ?? '',
        record.pages ?? '',
        record.doi ?? '',
        record.arxivId ?? '',
        record.pmid ?? '',
        record.citedBy ?? '',
        reachLabel(record),
        (record.sources ?? []).join('+'),
    ]);
    return [header, ...rows];
}

function renderResolve(result) {
    const lines = [];
    const ids = [result.doi && `DOI ${result.doi}`, result.arxivId && `arXiv ${result.arxivId}`, result.pmid && `PMID ${result.pmid}`, result.pmcid].filter(Boolean);
    lines.push(ids.length ? ids.join(' · ') : '（未解析到标识符）', '');
    if (result.candidates.length === 0) {
        lines.push('没有找到可公开获取的全文。', '');
        lines.push('这不等于论文不存在：可能是订阅期刊且无 OA 版本。可以改用标题检索、向作者索取，或走机构订阅。');
    }
    else {
        lines.push(`找到 ${result.candidates.length} 个候选：`, '');
        result.candidates.forEach((entry, index) => lines.push(describeCandidate(entry, index)));
    }
    if (result.attempts?.length) {
        lines.push('', '解析过程：');
        for (const attempt of result.attempts) lines.push(`- ${attempt.source}: ${attempt.ok ? 'ok' : 'skip/fail'} — ${attempt.note}`);
    }
    return lines.join('\n').trim();
}

/**
 * Validate the config, then register the tools, prompt section, and defaults.
 * Every registration is an effect on `ctx`, so disposing this fiber removes it all.
 * @param ctx - plugin context with `tools` ready.
 * @param config - schemastery-validated config.
 */
export function apply(ctx, config) {
    const settings = { ...config };
    const dataDir = resolveDataDir(settings.dataDir);
    const mailto = settings.openalexMailto.trim() || undefined;
    const unpaywallEmail = (settings.unpaywallEmail || settings.openalexMailto || '').trim() || undefined;

    const resolveInput = async (input, signal, budget = {}) => {
        const [coreApiKey, semanticScholarApiKey, openalexApiKey, elsevierApiKey] = await Promise.all([
            credentialValue(ctx, settings.coreApiKeyEnv),
            credentialValue(ctx, settings.semanticScholarApiKeyEnv),
            credentialValue(ctx, settings.openalexApiKeyEnv),
            credentialValue(ctx, settings.elsevierApiKeyEnv),
        ]);
        return resolveFulltext(input, {
            mailto,
            unpaywallEmail,
            coreApiKey,
            semanticScholarApiKey,
            openalexApiKey,
            elsevierApiKey,
            ...transportOf(settings),
            ...budget,
            signal,
        });
    };

    /** One download attempt with the headers publisher hosts expect. */
    const downloadOne = (url, signal, extraHeaders = {}) => downloadPdf(url, {
        timeoutMs: settings.pdfTimeoutMs,
        retries: 1,
        proxy: settings.proxyUrl,
        institutionalProxy: settings.institutionalProxyUrl,
        ua: BROWSER_UA,
        headers: { accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5', ...extraHeaders },
        signal,
    });

    const browserOptions = () => ({
        port: settings.cdpPort,
        userDataDir: settings.chromeProfileDir.trim() || join(homedir(), '.dsh-literature', 'chrome'),
        chromePath: settings.chromePath.trim() || undefined,
        direct: settings.browserDirect,
    });

    /** Fetch through the user's own Chrome; never throws. */
    /** Try the plugin's own Chrome: native file save first, then response capture. */
    const downloadViaCdp = async (url, signal, timeoutMs) => {
        const options = browserOptions();
        // PDFs must arrive as files: the viewer would keep the bytes away from
        // every capture path. Written before launch, so it applies immediately.
        await ensurePdfDownloadPref(options.userDataDir);
        await ensureBrowser(options);
        const dir = join(homedir(), '.dsh-literature', 'tmp-dl', String(Date.now()));
        const saved = await downloadViaChromeFile(url, {
            port: settings.cdpPort,
            dir,
            timeoutMs: Math.min(timeoutMs ?? settings.pdfTimeoutMs, 25_000),
            signal,
        });
        if (saved.ok) return saved;
        const result = await fetchViaBrowser(url, {
            port: settings.cdpPort,
            timeoutMs: timeoutMs ?? Math.min(settings.pdfTimeoutMs, 60_000),
            signal,
            warmupUrl: warmupFor(url),
        });
        return result;
    };

    /**
     * Last resort: the user's own signed-in browser through the bsk CLI. Slower
     * than the plugin Chrome, but it can pass a page that only answers a reader.
     */
    const downloadViaBskCli = async (url) => {
        const cli = settings.bskPath.trim() || 'bsk';
        if (!(await bskReady(cli))) {
            return { ok: false, error: 'bsk 未就绪（daemon 或浏览器扩展未连接）' };
        }
        const outFile = join(homedir(), '.dsh-literature', 'tmp-dl', `bsk-${Date.now()}.pdf`);
        await mkdir(join(homedir(), '.dsh-literature', 'tmp-dl'), { recursive: true });
        const pageUrl = warmupFor(url) ?? url;
        const got = await downloadViaBsk({ bskPath: cli, pageUrl, outFile });
        if (!got.ok) return { ok: false, error: got.error };
        try {
            const bytes = await readFile(got.file);
            await unlink(got.file).catch(() => undefined);
            if (!looksLikePdf(bytes)) return { ok: false, error: 'bsk 拿到的不是 PDF' };
            return { ok: true, bytes, finalUrl: pageUrl, contentType: 'application/pdf' };
        }
        catch (error) {
            return { ok: false, error: `bsk 文件读取失败：${error?.message ?? error}` };
        }
    };

    /** Fetch through a browser; never throws. Tries CDP, then bsk, per config. */
    const downloadViaBrowser = async (url, signal, timeoutMs) => {
        try {
            const order = settings.browserEngine === 'bsk' ? ['bsk', 'cdp'] : ['cdp', 'bsk'];
            const failures = [];
            for (const engine of order) {
                if (engine === 'bsk' && settings.browserEngine === 'cdp') continue;
                if (engine === 'bsk' && signal?.aborted) break;
                let result;
                try {
                    result = engine === 'bsk'
                        ? await downloadViaBskCli(url)
                        : await downloadViaCdp(url, signal, timeoutMs);
                }
                catch (error) {
                    failures.push(`${engine}: ${error?.message ?? error}`);
                    continue;
                }
                if (result?.ok) {
                    return {
                        ...result,
                        length: result.bytes.byteLength,
                        sha256: createHash('sha256').update(result.bytes).digest('hex'),
                    };
                }
                failures.push(`${engine}: ${result?.error ?? '未拿到 PDF'}`);
            }
            return { ok: false, error: `浏览器通道失败：${failures.join('；')}` };
        }
        catch (error) {
            return { ok: false, error: `浏览器通道失败：${error?.message ?? error}` };
        }
    };

    ctx.tools.register(defineTool({
        name: 'lit_search',
        description: 'Search the literature across OpenAlex, Crossref, arXiv, PubMed and Semantic Scholar in parallel (free, no key needed), then de-duplicate by DOI and normalized title. Every hit reports whether a legal full text is reachable (arXiv PDF, PMC, or an OA copy). Start here, then use lit_resolve and lit_read on the papers that matter.',
        parameters: {
            query: {
                type: 'string',
                required: true,
                description: 'Keywords or a natural-language question. Platform field syntax is passed through (PubMed tags, arXiv ti:/au:/cat:, boolean AND/OR).',
            },
            sources: {
                type: 'array',
                items: { type: 'string', enum: [...SOURCES] },
                description: `Platforms to query. Default: ${settings.defaultSources.join(', ')}. PubMed is for biomedical topics; arXiv only covers preprints.`,
            },
            max_per_source: {
                type: 'integer',
                description: `Results per platform (default ${settings.maxPerSource}, max 50).`,
            },
            year_from: { type: 'integer', description: 'Earliest publication year.' },
            year_to: { type: 'integer', description: 'Latest publication year.' },
            journal: { type: 'string', description: 'Scope the search to one journal: title or ISSN, e.g. "Management Science" or "0025-1909".' },
            volume: { type: 'string', description: 'Keep only papers from one volume, e.g. "71" (applied after de-duplication).' },
            export: { type: 'string', enum: ['none', 'xlsx'], description: 'Write the result list to an .xlsx workbook in the library folder.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    total: { type: 'number' },
                    reachable: { type: 'number' },
                    markdown: { type: 'string' },
                    exportPath: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        timeoutMs: settings.toolTimeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const requested = Array.isArray(args.sources) && args.sources.length > 0 ? args.sources : settings.defaultSources;
            const sources = [...new Set(requested.filter((source) => SOURCES.includes(source)))];
            const perSource = Math.max(1, Math.min(50, args.max_per_source ?? settings.maxPerSource));
            const [s2ApiKey, pubmedApiKey, openalexApiKey] = await Promise.all([
                credentialValue(ctx, settings.semanticScholarApiKeyEnv),
                credentialValue(ctx, settings.pubmedApiKeyEnv),
                credentialValue(ctx, settings.openalexApiKeyEnv),
            ]);
            // Journal scoping is resolved against OpenAlex sources, so a search
            // never has to drive the publisher's own site just to stay in one journal.
            let scope;
            let journalId;
            let journalName;
            if (typeof args.journal === 'string' && args.journal.trim().length > 0) {
                const resolved = await resolveJournal(args.journal, {
                    mailto,
                    openalexApiKey,
                    ...transportOf(settings),
                    timeoutMs: Math.min(settings.requestTimeoutMs, 15_000),
                    retries: 1,
                    signal: exec?.signal,
                }).catch(() => undefined);
                if (resolved) {
                    journalId = resolved.id;
                    journalName = resolved.name;
                    scope = `${resolved.name}${resolved.issn ? ` (ISSN ${resolved.issn})` : ''}`;
                }
                else {
                    scope = `${args.journal}（未在 OpenAlex 中解析到该刊，仅按刊名匹配 Crossref）`;
                    journalName = args.journal.trim();
                }
            }
            const results = await searchAll(args.query, {
                sources,
                limit: perSource,
                yearFrom: args.year_from,
                yearTo: args.year_to,
                mailto,
                s2ApiKey,
                pubmedApiKey,
                openalexApiKey,
                journalId,
                journalName,
                ...transportOf(settings),
                timeoutMs: Math.min(settings.requestTimeoutMs, 15_000),
                retries: 1,
                signal: exec?.signal,
            });
            let works = rankWorks(dedupeWorks(results.flatMap((result) => result.works)));
            if (typeof args.volume === 'string' && args.volume.trim().length > 0) {
                const wanted = args.volume.trim();
                works = works.filter((record) => String(record.volume ?? '') === wanted);
            }
            const failures = results.filter((result) => result.error).map((result) => ({ source: result.source, error: result.error }));
            const counts = results.map((result) => ({ source: result.source, count: result.works.length }));
            let exportPath = '';
            if (args.export === 'xlsx') {
                try {
                    const dir = join(dataDir, 'exports');
                    await mkdir(dir, { recursive: true });
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    const file = join(dir, `search-${stamp}.xlsx`);
                    await writeFile(file, buildXlsx(exportRows(works), {
                        sheetName: 'papers',
                        widths: [70, 40, 28, 8, 6, 6, 14, 30, 16, 12, 8, 18, 24],
                    }));
                    exportPath = file;
                }
                catch (error) {
                    exportPath = `导出失败：${error?.message ?? error}`;
                }
            }
            return {
                total: works.length,
                reachable: works.filter((record) => reachLabel(record) !== 'metadata only').length,
                markdown: renderSearch({ query: args.query, works, perSource: counts, failures, config: settings, scope, exportPath }),
                exportPath,
            };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'lit_resolve',
        description: 'Resolve where a paper\'s full text legally lives. Walks the open-access chain (arXiv, Europe PMC, Unpaywall, OpenAlex locations, Semantic Scholar, CORE) and returns ranked candidates with license and version, plus which oracles answered. Use it before download attempts, and to report honestly when nothing is reachable.',
        parameters: {
            doi: { type: 'string', description: 'DOI, with or without the https://doi.org/ prefix.' },
            arxiv_id: { type: 'string', description: 'arXiv identifier, e.g. 2106.12345.' },
            pmid: { type: 'string', description: 'PubMed identifier.' },
            pmcid: { type: 'string', description: 'PubMed Central identifier, e.g. PMC8123456.' },
            title: { type: 'string', description: 'Paper title; only used when no identifier is given (resolved through OpenAlex).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    available: { type: 'boolean' },
                    count: { type: 'number' },
                    markdown: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        timeoutMs: settings.toolTimeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const result = await resolveInput({
                doi: args.doi,
                arxivId: args.arxiv_id,
                pmid: args.pmid,
                pmcid: args.pmcid,
                title: args.title,
            }, exec?.signal);
            return {
                available: result.candidates.length > 0,
                count: result.candidates.length,
                markdown: renderResolve(result),
            };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'lit_fetch_pdf',
        description: 'Download a paper\'s PDF into the local library. Resolves the open-access chain, tries candidates in trust order, rejects responses that are not real PDFs (login/landing pages), and caches by paper identity so a second call reuses the file. Returns the local path and sha256.',
        parameters: {
            doi: { type: 'string', description: 'DOI of the paper.' },
            arxiv_id: { type: 'string', description: 'arXiv identifier.' },
            pmid: { type: 'string', description: 'PubMed identifier.' },
            url: { type: 'string', description: 'Direct PDF URL, when you already have one.' },
            title: { type: 'string', description: 'Title, when no identifier is available.' },
            force: { type: 'boolean', description: 'Re-download even when a cached PDF exists.' },
            via_browser: { type: 'string', enum: ['auto', 'on', 'off'], description: 'auto (default) = try plain HTTP, then the local Chrome; on = Chrome first; off = HTTP only.' },
            naming: { type: 'string', enum: ['hash', 'pubmed'], description: 'hash (default) = <year>_<journal>_<author>_<title>.pdf copy in the library folder; hash = only the content-addressed cache.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string' },
                    bytes: { type: 'number' },
                    sha256: { type: 'string' },
                    source: { type: 'string' },
                    cached: { type: 'boolean' },
                    markdown: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        timeoutMs: settings.toolTimeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const identity = {
                doi: normalizeDoi(args.doi),
                arxivId: args.arxiv_id,
                pmid: args.pmid,
                title: args.title,
                titleKey: titleKey(args.title),
            };
            const key = paperKey(identity);
            if (!args.force) {
                const cached = await readCached(dataDir, key, 'pdf');
                if (cached) {
                    return {
                        path: cached.path,
                        bytes: cached.info.size,
                        sha256: '',
                        source: 'cache',
                        cached: true,
                        markdown: `已缓存：${cached.path}\n${cached.info.size} 字节。需要重新下载请传 force: true。`,
                    };
                }
            }
            let candidates = [];
            if (typeof args.url === 'string' && args.url.length > 0) {
                candidates = [{ source: 'direct', url: args.url, trust: 999 }];
            }
            else {
                const resolved = await resolveInput(identity, exec?.signal);
                if (resolved.candidates.length === 0) {
                    return {
                        path: '',
                        bytes: 0,
                        sha256: '',
                        source: 'none',
                        cached: false,
                        markdown: `没有找到可公开获取的全文（DOI ${resolved.doi ?? '—'}）。\n${renderResolve(resolved)}`,
                    };
                }
                candidates = resolved.candidates;
            }
            // Institutional access adds publisher routes, so allow more attempts.
            const budget = settings.institutionalProxyUrl || settings.ezproxyPrefix ? 6 : 3;
            const failures = [];
            // Hard stop before the tool budget runs out: a three-minute silence is
            // worse than an honest "nothing complete yet".
            const deadline = Date.now() + Math.max(30_000, settings.toolTimeoutMs - 25_000);
            const remaining = () => Math.max(5_000, deadline - Date.now());
            let label = args.title;
            let meta = { title: args.title, year: undefined, venue: undefined, author: undefined };
            if (identity.doi) {
                const looked = await lookupTitleByDoi(identity.doi, { mailto, ...transportOf(settings) }).catch(() => undefined);
                if (looked) {
                    label = label ?? looked.title;
                    meta = { ...meta, ...Object.fromEntries(Object.entries(looked).filter(([, value]) => value !== undefined)) };
                }
            }
            if (identity.pmid) {
                const looked = await lookupTitleByPmid(identity.pmid, {
                    pubmedApiKey: await credentialValue(ctx, settings.pubmedApiKeyEnv),
                    mailto,
                    ...transportOf(settings),
                }).catch(() => undefined);
                if (looked) {
                    label = label ?? looked.title;
                    // PubMed's journal field is the ISO abbreviation, which is what
                    // a reading-list file name should carry.
                    meta = { ...meta, ...Object.fromEntries(Object.entries(looked).filter(([, value]) => value !== undefined)) };
                }
            }
            if (identity.arxivId && !meta.year) {
                const looked = await lookupArxivMeta(identity.arxivId, { mailto, ...transportOf(settings) }).catch(() => undefined);
                if (looked) {
                    label = label ?? looked.title;
                    meta = { ...meta, ...Object.fromEntries(Object.entries(looked).filter(([, value]) => value !== undefined)) };
                }
            }
            // Plain HTTP first (cheap, and enough for arXiv/OA hosts); the user's
            // Chrome second, because a real browser on campus is what the
            // publishers and PMC actually answer.
            const mode = args.via_browser ?? 'auto';
            const plans = [];
            if (mode !== 'on') plans.push('http');
            if (settings.browserDownload && mode !== 'off') plans.push('browser');
            if (mode === 'on') plans.push('http');

            // Repository handles (Unpaywall often reports `hdl.handle.net/…`) are
            // pages, not files. Open each once in the browser and promote the
            // download links it exposes into real candidates.
            if (settings.browserDownload && mode !== 'off') {
                const landings = candidates.filter((candidate) => candidate.kind === 'landing').slice(0, 2);
                for (const landing of landings) {
                    if (Date.now() > deadline) break;
                    try {
                        await ensureBrowser(browserOptions());
                        const links = await extractPdfLinks(landing.url, {
                            port: settings.cdpPort,
                            timeoutMs: Math.min(remaining(), 45_000),
                            signal: exec?.signal,
                        });
                        for (const link of links) {
                            // Promoted links are real files behind a slow repository:
                            // try them first, before the pages that already failed.
                            candidates.unshift({ ...landing, url: link, kind: 'pdf', trust: 95 });
                        }
                        if (links.length > 0) failures.push(`${landing.source}: 仓库页里找到 ${links.length} 个下载链`);
                    }
                    catch (error) {
                        failures.push(`${landing.source}: 仓库页打不开（${error?.message ?? error}）`);
                    }
                }
            }

            /** Save, parse, and shape the tool result for one successful download. */
            const finalize = async (download, candidate, viaLabel, prep) => {
                const saved = await savePaper(dataDir, key, download, {
                    title: label,
                    doi: identity.doi,
                    arxivId: identity.arxivId,
                    pmid: identity.pmid,
                    license: candidate.license,
                    version: candidate.version,
                    via: viaLabel,
                });
                let parsed = '';
                if (saved.duplicateOf) {
                    // Same bytes already stored under another identifier (a journal
                    // DOI whose open copy is the preprint): keep one entry only.
                    return {
                        path: saved.path,
                        bytes: saved.bytes ?? 0,
                        sha256: saved.sha256 ?? '',
                        source: candidate.source,
                        cached: true,
                        markdown: [
                            '同一份文件已在库里（内容哈希相同），没有重复保存。',
                            `已存在：${saved.path}`,
                            saved.title ? `原标题：${saved.title}` : '',
                            saved.aliases?.length ? `别名：${saved.aliases.join(' · ')}` : '',
                            '要单独存一份，先在库里删掉那条再下。',
                        ].filter(Boolean).join('\n'),
                    };
                }
                try {
                    const extracted = prep ?? await extractText(download.bytes);
                    const markdown = extracted.markdown ?? toMarkdown(extracted.text);
                    if (markdown.length > 0) {
                        await saveMarkdown(dataDir, key, markdown, extracted.pages);
                        parsed = `${extracted.pages} 页 · ${markdown.length} 字符已解析`;
                    }
                }
                catch (error) {
                    parsed = `解析失败（可稍后用 lit_read 重试）：${error?.message ?? error}`;
                }
                // A readable copy for the user's own reading list, Zotero, or a
                // supervisor: 2020_N Engl J Med_Beck_Somatic Mutations.pdf
                let namedPath = '';
                if (args.naming === 'pubmed') {
                    try {
                        namedPath = await saveNamedCopy(dataDir, saved.path, download.bytes, libraryFileName({
                            year: meta.year,
                            venue: meta.venue,
                            author: meta.author,
                            title: meta.title ?? label,
                            key,
                        }));
                    }
                    catch (error) {
                        namedPath = `命名副本写入失败：${error?.message ?? error}`;
                    }
                }
                return {
                    path: saved.path,
                    bytes: saved.bytes,
                    sha256: saved.sha256,
                    source: candidate.source,
                    cached: false,
                    markdown: [
                        `已保存：${saved.path}`,
                        `${saved.bytes} 字节 · sha256 ${saved.sha256.slice(0, 16)}…`,
                        `来源：${candidate.source} · ${candidate.url}`,
                        `获取方式：${viaLabel}`,
                        candidate.license ? `许可：${candidate.license}` : '',
                        namedPath ? `阅读版：${namedPath}` : '',
                        parsed,
                        '全文已可检索：lit_library 里搜关键词，或 lit_read 分段读。',
                    ].filter(Boolean).join('\n'),
                };
            };

            // A publisher can answer with a one-page preview while the real article
            // stays behind a subscription. "Openable" is not "complete": check the
            // page count before accepting, and keep trying the next channel.
            const inspectDownload = async (download) => {
                try {
                    const extracted = await extractText(download.bytes);
                    const markdown = toMarkdown(extracted.text);
                    return { pages: extracted.pages ?? 0, markdown, text: extracted.text };
                }
                catch (error) {
                    return { pages: 0, chars: 0, error: error?.message ?? String(error) };
                }
            };
            const isPreview = (probe) => isPreviewProbe(probe);
            let previewFallback;

            // Already fetched from one of these URLs (a journal DOI whose open copy
            // is the preprint): skip the download entirely rather than re-fetch MBs.
            if (!args.force) {
                const known = await findAnyByUrl(dataDir, candidates.map((candidate) => candidate.url));
                if (known) {
                    const existing = await readCached(dataDir, known, 'pdf');
                    return {
                        path: existing?.path ?? '',
                        bytes: existing?.info.size ?? 0,
                        sha256: '',
                        source: 'cache',
                        cached: true,
                        markdown: [
                            '库里已有这篇：同一个下载地址之前取过，不再重复下载。',
                            `已存在：${existing?.path ?? known}`,
                            '确实要重下请传 force: true。',
                        ].join('\n'),
                    };
                }
            }

            for (const plan of plans) {
                const limit = plan === 'browser' ? 3 : budget;
                for (const candidate of candidates.slice(0, limit)) {
                    // A page-shaped candidate was already expanded above; asking the
                    // browser to fetch the page itself only burns the time budget.
                    if (plan === 'browser' && candidate.kind === 'landing') continue;
                    if (Date.now() > deadline) {
                        failures.push('时间预算用完，未尝试的通道已跳过');
                        break;
                    }
                    const download = plan === 'browser'
                        ? await downloadViaBrowser(candidate.url, exec?.signal, Math.min(remaining() - 5_000, 120_000))
                        : await downloadOne(candidate.url, exec?.signal, candidate.headers);
                    if (!download.ok) {
                        failures.push(`${candidate.source}${plan === 'browser' ? '（浏览器）' : ''}: ${download.error}`);
                        continue;
                    }
                    const probe = await inspectDownload(download);
                    if (isPreview(probe)) {
                        previewFallback = previewFallback ?? { download, candidate, plan, probe };
                        failures.push(`${candidate.source}: 只给出预览版（${probe.pages} 页 / ${probe.markdown?.length ?? 0} 字符），继续找完整版`);
                        continue;
                    }
                    return finalize(download, candidate, plan === 'browser' ? '你的 Chrome（真实浏览器会话）' : '直连 HTTP', probe);
                }
            }

            // Last resort: open the article page and click its own PDF control.
            // Bot walls answer a reader, not a URL.
            let needsHuman = false;
            if (settings.browserDownload && mode !== 'off' && Date.now() < deadline) {
                for (const candidate of candidates.slice(0, 2)) {
                    const articleUrl = warmupFor(candidate.url);
                    if (!articleUrl) continue;
                    if (Date.now() > deadline) break;
                    try {
                        await ensureBrowser(browserOptions());
                        // The reader's click yields a signed asset URL; watch for it
                        // while the article route waits, then fetch that URL directly.
                        const harvest = harvestAssetUrl({
                            port: settings.cdpPort,
                            timeoutMs: Math.min(remaining(), 75_000),
                            signal: exec?.signal,
                        });
                        const download = await fetchViaArticlePage({
                            port: settings.cdpPort,
                            articleUrl,
                            timeoutMs: Math.min(remaining(), 45_000),
                            humanTimeoutMs: Math.min(settings.humanWaitMs, remaining()),
                            signal: exec?.signal,
                        });
                        const asset = await harvest;
                        if (asset) {
                            // The signed link still needs the browser session: a bare
                            // HTTP request for it is refused, the browser gets bytes.
                            const got = await downloadViaBrowser(asset.url, exec?.signal, Math.min(remaining(), 60_000));
                            if (got.ok) {
                                const assetProbe = await inspectDownload(got);
                                if (!isPreview(assetProbe)) {
                                    return finalize(got, { ...candidate, source: 'publisher-asset', license: candidate.license }, '你的 Chrome（你点开后抓到的签名链）', assetProbe);
                                }
                                failures.push(`签名链: 只有 ${assetProbe.pages} 页（预览）`);
                            }
                            else {
                                failures.push(`签名链下载失败: ${got.error}`);
                            }
                        }
                        if (download.needsHuman) {
                            needsHuman = true;
                            failures.push(`${candidate.source}（文章页点击）: ${download.error}`);
                            continue;
                        }
                        if (download.ok) {
                            const probe = await inspectDownload(download);
                            if (isPreview(probe)) {
                                previewFallback = previewFallback ?? { download, candidate, plan: 'article', probe };
                                failures.push(`${candidate.source}（文章页点击）: 仍只有预览版（${probe.pages} 页）`);
                                continue;
                            }
                            return finalize(download, candidate, '你的 Chrome（打开文章页后点 View PDF）', probe);
                        }
                        failures.push(`${candidate.source}（文章页点击）: ${download.error}`);
                    }
                    catch (error) {
                        failures.push(`${candidate.source}（文章页点击）: ${error?.message ?? error}`);
                    }
                }
            }

            // Nothing complete, but a preview was reachable: keep it, and say so.
            if (previewFallback) {
                const { download, candidate, plan, probe } = previewFallback;
                const viaLabel = plan === 'browser' ? '你的 Chrome（只拿到预览版）'
                    : plan === 'article' ? '你的 Chrome（文章页仍只有预览版）'
                        : '直连 HTTP（只拿到预览版）';
                const result = await finalize(download, candidate, viaLabel, probe);
                return {
                    ...result,
                    markdown: [
                        '⚠️ 只拿到**预览版**（首页），不是完整文章。',
                        result.markdown,
                        '',
                        '完整版为什么没拿到：',
                        ...failures.filter((line) => line.includes('预览')).concat(
                            failures.filter((line) => !line.includes('预览')),
                        ).slice(0, 6).map((line) => `- ${line}`),
                        '',
                        needsHuman
                            ? '（有一次尝试需要你在 Chrome 窗口里点 View PDF，20 秒内没等到。）'
                            : '',
                        '三条出路：',
                        '1. 让图书馆开通 Elsevier `instToken`（一次沟通，永久解决）',
                        '2. 你在浏览器里手动下载这一篇',
                        '3. 文献传递',
                    ].filter((line) => line !== '').join('\n'),
                };
            }

            return {
                path: '',
                bytes: 0,
                sha256: '',
                source: 'failed',
                cached: false,
                markdown: [
                    '所有候选都下载失败：',
                    ...failures.map((line) => `- ${line}`),
                    '',
                    settings.browserDownload
                        ? '浏览器通道也试过了。如果浏览器窗口里弹出了人机验证，请在那个窗口里点一下再重试。'
                        : '浏览器通道未启用（browserDownload: false），所以只能走直连 HTTP。',
                ].join('\n'),
            };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'lit_read',
        description: `Read a paper's full text as Markdown. Accepts a cached download, a local PDF path, a direct URL, or an identifier (then it fetches first). Returns one slice per call: follow hasMore/nextOffset. Text comes from a local PDF extractor with a light heuristic structure pass, so headings are approximate.`,
        parameters: {
            doi: { type: 'string', description: 'DOI of the paper.' },
            arxiv_id: { type: 'string', description: 'arXiv identifier.' },
            pmid: { type: 'string', description: 'PubMed identifier.' },
            path: { type: 'string', description: 'Absolute path to a local PDF.' },
            url: { type: 'string', description: 'Direct PDF URL.' },
            offset: { type: 'integer', description: 'Character offset to start from (default 0).' },
            max_chars: { type: 'integer', description: `Characters to return (default ${settings.readMaxChars}).` },
            find: { type: 'string', description: 'Locate passages instead of slicing: literal text or a regular expression. Returns each match with surrounding context.' },
            refresh: { type: 'boolean', description: 'Ignore the cached Markdown and re-parse the PDF.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string' },
                    pages: { type: 'number' },
                    chars: { type: 'number' },
                    text: { type: 'string' },
                    hasMore: { type: 'boolean' },
                    nextOffset: { type: 'number' },
                },
            },
            render: (_args, value) => [{
                type: 'text',
                text: `${value.text}${value.hasMore ? `\n\n---\n（共 ${value.chars} 字符，下一页 offset=${value.nextOffset}）` : ''}`,
            }],
        },
        timeoutMs: settings.toolTimeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const maxChars = Math.max(1000, Math.min(200_000, args.max_chars ?? settings.readMaxChars));
            const offset = Math.max(0, args.offset ?? 0);
            const identity = {
                doi: normalizeDoi(args.doi),
                arxivId: args.arxiv_id,
                pmid: args.pmid,
                titleKey: titleKey(args.title),
            };
            const key = paperKey(identity);

            let pdfPath;
            let markdown = '';
            let pages = 0;

            if (typeof args.path === 'string' && args.path.length > 0) {
                pdfPath = args.path;
            }
            else if (!args.refresh) {
                const cachedMd = await readCached(dataDir, key, 'md');
                if (cachedMd) markdown = await (await import('node:fs/promises')).readFile(cachedMd.path, 'utf8');
                if (!markdown) {
                    const cachedPdf = await readCached(dataDir, key, 'pdf');
                    if (cachedPdf) pdfPath = cachedPdf.path;
                }
            }

            // Elsevier's TDM API returns complete JATS XML, while its PDFs are
            // often image-only, so prefer the XML whenever the DOI is known and
            // the cached Markdown looks thin (or absent).
            if (identity.doi && markdown.length < 8_000) {
                const elsevierApiKey = await credentialValue(ctx, settings.elsevierApiKeyEnv);
                if (elsevierApiKey) {
                    const full = await fetchElsevierFullText(identity.doi, elsevierApiKey, {
                        ...transportOf(settings),
                        timeoutMs: Math.min(settings.pdfTimeoutMs, 90_000),
                        signal: exec?.signal,
                    }).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
                    if (full.ok) {
                        markdown = full.markdown;
                        pages = 0;
                        await saveMarkdown(dataDir, key, markdown, 0);
                    }
                }
            }

            if (!markdown && !pdfPath) {
                const candidates = typeof args.url === 'string' && args.url.length > 0
                    ? [{ source: 'direct', url: args.url, trust: 999 }]
                    : (await resolveInput(identity, exec?.signal)).candidates;
                for (const candidate of candidates.slice(0, 3)) {
                    let download = await downloadOne(candidate.url, exec?.signal, candidate.headers);
                    if (!download.ok && settings.browserDownload) download = await downloadViaBrowser(candidate.url, exec?.signal);
                    if (!download.ok) continue;
                    const saved = await savePaper(dataDir, key, download, {
                        doi: identity.doi,
                        arxivId: identity.arxivId,
                        pmid: identity.pmid,
                        license: candidate.license,
                    });
                    pdfPath = saved.path;
                    break;
                }
            }

            if (!markdown) {
                if (!pdfPath) {
                    return {
                        path: '',
                        pages: 0,
                        chars: 0,
                        text: '没有可读的全文：既没有缓存，也没有解析出可公开下载的 PDF。',
                        hasMore: false,
                        nextOffset: 0,
                    };
                }
                const { readFile } = await import('node:fs/promises');
                const bytes = await readFile(pdfPath);
                const extracted = await extractText(bytes);
                markdown = toMarkdown(extracted.text);
                pages = extracted.pages;
                if (markdown.length > 0) {
                    await saveMarkdown(dataDir, key, markdown, pages);
                }
            }

            // Locate a passage instead of paging through the document.
            if (typeof args.find === 'string' && args.find.trim().length > 0) {
                const { matches, total, mode } = findInText(markdown, args.find, { limit: 5, context: 320 });
                return {
                    path: pdfPath ?? '',
                    pages,
                    chars: markdown.length,
                    text: `${formatMatches(matches, args.find)}\n\n（全文 ${markdown.length} 字符 · 命中 ${total} 处 · 按${mode === 'regex' ? '正则' : '字面'}匹配）`,
                    hasMore: false,
                    nextOffset: 0,
                };
            }

            const slice = sliceText(markdown, offset, maxChars);
            return {
                path: pdfPath ?? '',
                pages,
                chars: slice.total,
                text: slice.text,
                hasMore: slice.hasMore,
                nextOffset: slice.hasMore ? slice.end : 0,
            };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'lit_library',
        description: 'Search the local full-text library (every paper cached by lit_fetch_pdf / lit_read) with a literal string or a regular expression, returning title, DOI, and highlighted snippets. Call it with no query to list what is cached.',
        parameters: {
            query: { type: 'string', description: 'Literal text or regular expression; omit to list cached papers.' },
            limit: { type: 'integer', description: 'Maximum hits (default 20, max 50).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    count: { type: 'number' },
                    markdown: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        timeoutMs: settings.toolTimeoutMs,
        isConcurrencySafe: () => true,
        async execute(args) {
            const limit = Math.max(1, Math.min(50, args.limit ?? 20));
            if (typeof args.query !== 'string' || args.query.trim().length === 0) {
                const papers = await listLibrary(dataDir, limit);
                if (papers.length === 0) return { count: 0, markdown: `全文库为空（${dataDir}）。先 lit_fetch_pdf 或 lit_read。` };
                const lines = [`## 全文库（${papers.length} 篇，${dataDir}）`, ''];
                for (const paper of papers) {
                    const label = paper.title ?? paper.arxivId ?? (paper.doi ? `DOI ${paper.doi}` : paper.key);
                    const ids = [paper.doi && `DOI ${paper.doi}`, paper.arxivId && `arXiv ${paper.arxivId}`, paper.pages && `${paper.pages} 页`].filter(Boolean).join(' · ');
                    lines.push(`- **${label}**${paper.year ? ` (${paper.year})` : ''}${ids ? ` — ${ids}` : ''}`);
                }
                return { count: papers.length, markdown: lines.join('\n') };
            }
            const { scanned, hits } = await searchLibrary(dataDir, args.query.trim(), { limit });
            if (hits.length === 0) {
                return { count: 0, markdown: `在 ${scanned} 篇已缓存全文里没有命中「${args.query}」。` };
            }
            const lines = [`## 「${args.query}」命中 ${hits.length} 处（扫描 ${scanned} 篇）`, ''];
            for (const hit of hits) {
                const label = hit.title ?? hit.arxivId ?? (hit.doi ? `DOI ${hit.doi}` : hit.key);
                lines.push(`- **${label}**${hit.year ? ` (${hit.year})` : ''}`, `  …${hit.snippet}…`);
            }
            return { count: hits.length, markdown: lines.join('\n') };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'lit_import',
        description: 'Import PDFs you downloaded yourself. Publishers such as Nature, ACS and Wiley hand a real browser a file instead of a readable link, so nothing can be harvested; this tool takes whatever landed in your download folder, identifies each paper by the DOI printed inside it, stores it, parses it to Markdown, and files it under 年份_期刊_作者_标题.pdf. Duplicates are skipped by content hash.',
        parameters: {
            dir: { type: 'string', description: 'Folder to scan; default is your Downloads folder (or the importDir setting).' },
            limit: { type: 'integer', description: 'Maximum files to consider (default 50).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    imported: { type: 'number' },
                    skipped: { type: 'number' },
                    markdown: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        timeoutMs: settings.toolTimeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const dir = (typeof args.dir === 'string' && args.dir.trim().length > 0)
                ? args.dir.trim()
                : (settings.importDir.trim() || defaultImportDir());
            const openalexApiKey = await credentialValue(ctx, settings.openalexApiKeyEnv);
            const { rows, error } = await importPdfs({
                dir,
                dataDir,
                naming: 'pubmed',
                limit: args.limit ?? 50,
                signal: exec?.signal,
                transport: { ...transportOf(settings), mailto, openalexApiKey },
            });
            if (error) return { imported: 0, skipped: 0, markdown: `❌ ${error}` };
            if (rows.length === 0) return { imported: 0, skipped: 0, markdown: `目录里没有待导入的 PDF：${dir}` };
            const icon = { imported: '✅', duplicate: '⏭', skipped: '⏭', failed: '❌' };
            const lines = [`## 导入结果（${dir}）`, ''];
            let imported = 0;
            let skipped = 0;
            for (const row of rows) {
                if (row.status === 'imported') {
                    imported += 1;
                    lines.push(`${icon[row.status]} **${row.title ?? row.file}**`);
                    lines.push(`   ${row.pages} 页 · ${row.chars} 字符${row.doi ? ` · DOI ${row.doi}` : ''}`);
                    if (row.namedPath) lines.push(`   阅读版：${row.namedPath}`);
                }
                else {
                    skipped += 1;
                    lines.push(`${icon[row.status] ?? '⏭'} ${row.file} —— ${row.note ?? row.status}`);
                }
            }
            lines.push('', `导入 ${imported} 篇，跳过 ${skipped} 个。`);
            return { imported, skipped, markdown: lines.join('\n') };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'lit_doctor',
        description: 'Self-check for this plugin. Reports the Node version, whether the data directory is writable, whether the PDF parser loads, whether Chrome was found, which proxy would be used, which credentials are configured, and whether browser-skill is ready. Run it first when a search or download misbehaves.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    markdown: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute() {
            const rows = [];
            const add = (ok, label, detail) => rows.push({ ok, label, detail });

            const [major, minor] = process.versions.node.split('.').map(Number);
            add(major > 22 || (major === 22 && minor >= 19), 'Node 版本', `${process.versions.node}（需要 ≥ 22.19）`);

            try {
                await mkdir(dataDir, { recursive: true });
                const probe = join(dataDir, `.doctor-${Date.now()}`);
                await writeFile(probe, 'ok');
                await unlink(probe);
                add(true, '数据目录可写', dataDir);
            }
            catch (error) {
                add(false, '数据目录可写', `${dataDir} — ${error?.message ?? error}`);
            }

            try {
                await import('pdf-parse');
                add(true, 'PDF 解析器', 'pdf-parse 可加载');
            }
            catch (error) {
                add(false, 'PDF 解析器', `pdf-parse 加载失败（在该包目录执行 npm install）：${error?.message ?? error}`);
            }

            const chrome = findChrome();
            add(Boolean(chrome), 'Chrome', chrome ?? '未找到；浏览器通道不可用');

            try {
                const proxy = await resolveProxy(settings.proxyUrl);
                add(true, '代理', proxy || '不使用代理（直连）');
            }
            catch (error) {
                add(false, '代理', `探测失败：${error?.message ?? error}`);
            }

            const refs = [
                ['OPENALEX_API_KEY', settings.openalexApiKeyEnv],
                ['NCBI_API_KEY', settings.pubmedApiKeyEnv],
                ['SEMANTIC_SCHOLAR_API_KEY', settings.semanticScholarApiKeyEnv],
                ['ELSEVIER_API_KEY', settings.elsevierApiKeyEnv],
                ['CORE_API_KEY', settings.coreApiKeyEnv],
            ];
            for (const [label, refName] of refs) {
                const value = await credentialValue(ctx, refName);
                add(Boolean(value), `凭据 ${label}`, value ? '已配置' : `未配置（引用名 ${refName}）`);
            }
            add(Boolean(mailto), '礼貌池邮箱', mailto ? `openalexMailto = ${mailto}` : '未设置 openalexMailto');
            add(Boolean(unpaywallEmail), 'Unpaywall 邮箱', unpaywallEmail ? `unpaywallEmail = ${unpaywallEmail}` : '未设置 unpaywallEmail，OA 判定会少一路');

            const cli = settings.bskPath.trim() || 'bsk';
            add(await bskReady(cli).catch(() => false), 'browser-skill', (await bskReady(cli).catch(() => false)) ? 'CLI 与浏览器已就绪' : '未就绪（可选，仅用于登录墙站点）');

            let papers = 0;
            try {
                papers = (await listLibrary(dataDir, 1000)).length;
            }
            catch {
                papers = 0;
            }
            add(true, '本地库', `${papers} 篇可全文检索`);

            const failed = rows.filter((row) => !row.ok);
            const lines = [
                `## 自检：${failed.length === 0 ? '全部通过' : `${failed.length} 项需注意`}`,
                '',
                ...rows.map((row) => `${row.ok ? '✅' : '⚠️'} **${row.label}** — ${row.detail}`),
                '',
                failed.length === 0
                    ? '可以直接使用。'
                    : '带 ⚠️ 的项目不一定会阻断使用：没有 Elsevier key 时 Elsevier 走 OA/浏览器，没有 bsk 时少一条兜底通道。',
            ];
            return { ok: failed.length === 0, markdown: lines.join('\n') };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'lit_login',
        description: 'Sign in to a publisher once, in the plugin\'s own Chrome window, and keep that session for later downloads. Uses a persistent profile, so a session established here is reused without asking again. Call it with a url to open the sign-in page for the reader, or with check=true to report which publisher sessions are currently held.',
        parameters: {
            url: { type: 'string', description: 'Page to open for signing in, e.g. the article page or your library portal. Omit to only check the current session.' },
            check: { type: 'boolean', description: 'Report which publisher domains currently hold a session.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    opened: { type: 'boolean' },
                    path: { type: 'string' },
                    markdown: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.markdown }],
        },
        timeoutMs: 90_000,
        async execute(args) {
            const options = browserOptions();
            const port = settings.cdpPort;
            const hosts = ['pubs.acs.org', 'www.nature.com', 'onlinelibrary.wiley.com', 'www.sciencedirect.com', 'ieeexplore.ieee.org', 'pubs.rsc.org', 'link.springer.com', 'www.tandfonline.com', 'journals.sagepub.com', 'www.science.org'];
            let opened = false;
            if (typeof args.url === 'string' && args.url.trim().length > 0) {
                await ensurePdfDownloadPref(options.userDataDir);
                await openForLogin({ ...options, url: args.url.trim() });
                opened = true;
            }
            else {
                await ensureBrowser(options);
            }
            const session = await sessionStatus(port, hosts).catch(() => undefined);
            const lines = [];
            if (opened) {
                lines.push(
                    'Chrome 窗口已经打开（就在你桌面上），页面是：',
                    '',
                    `    ${args.url.trim()}`,
                    '',
                    '在那个窗口里登录机构账号 / 过掉人机验证。完成后告诉我一声，我重试下载。',
                    '',
                    '**登录状态会保留**：用的是插件自己的持久化浏览器配置，下次下载自动复用，不用再登。',
                );
            }
            if (session) {
                const signed = session.known.filter((entry) => entry.signedIn);
                lines.push(
                    '',
                    `**当前会话**：${session.domains} 个站点有 cookie（共 ${session.total} 条）`,
                    '',
                    ...(signed.length > 0
                        ? signed.map((entry) => `- ✅ ${entry.host}（${entry.cookies} 条）`)
                        : ['- 还没有任何出版社会话']),
                    '',
                    `配置目录：${options.userDataDir}`,
                    '（删掉这个目录就会清空所有登录状态）',
                );
            }
            return { opened, path: options.userDataDir, markdown: lines.join('\n').trim() };
        },
    }));

    if (settings.promptGuidance && typeof ctx.systemPrompt?.section === 'function') {
        ctx.systemPrompt.section({
            name: 'tool:literature',
            order: settings.promptOrder,
            text: [
                '### Full-text-first literature workflow (dsh-literature)',
                'Metadata search alone rarely yields full text. Use this order:',
                '1. `lit_search` for discovery (it already reports which hits have a reachable full text).',
                '2. `lit_resolve` on a specific paper to see where the legal copy lives and under which license/version.',
                '3. `lit_fetch_pdf`, then `lit_read` for the Markdown body; page with `nextOffset` when `hasMore`.',
                '4. `lit_library` to search everything already cached before repeating a download.',
                'Report paywalled and unreachable papers as such. Never infer or fabricate full-text content from an abstract: if no PDF was retrieved, say the full text is unavailable.',
                'Citations: quote the DOI reported by the tools; do not construct identifiers.',
            ].join('\n'),
        });
    }
}





