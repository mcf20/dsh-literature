/**
 * Source adapters. Each returns records in the same shape so `identity.js` can
 * merge them; each degrades to an error string instead of throwing.
 * @module dsh-literature/sources
 */
import { normalizeDoi, titleKey, yearOf } from './identity.js';
import { request, tidy, userAgent } from './net.js';

export const SOURCES = ['openalex', 'crossref', 'arxiv', 'pubmed', 'semantic-scholar'];
/** Per-platform ceilings; 200 is Crossref's practical `rows` max. */
export const SOURCE_CAP = { openalex: 100, crossref: 100, arxiv: 100, pubmed: 100, 'semantic-scholar': 100 };

const OPENALEX_WORKS = 'https://api.openalex.org/works';
const CROSSREF_WORKS = 'https://api.crossref.org/works';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
/**
 * Keep S2 calls at least a second apart across the whole process.
 *
 * A search and a metadata lookup can otherwise overlap and both receive 429.
 */
let s2Last = 0;
let s2Chain = Promise.resolve();
function s2Slot() {
    const wait = Math.max(0, s2Last + 1_200 - Date.now());
    s2Last = Date.now() + wait;
    s2Chain = s2Chain.then(() => new Promise((resolve) => setTimeout(resolve, wait)));
    return s2Chain;
}

const SEMANTIC_SEARCH = 'https://api.semanticscholar.org/graph/v1/paper/search';
const SEMANTIC_FIELDS = [
    'title', 'abstract', 'year', 'venue', 'authors', 'citationCount',
    'externalIds', 'openAccessPdf', 'publicationTypes', 'isOpenAccess',
].join(',');

/** OpenAlex stores abstracts as a word→positions map; rebuild the sentence. */
export function reconstructAbstract(inverted) {
    if (!inverted || typeof inverted !== 'object') return undefined;
    const slots = [];
    for (const [word, positions] of Object.entries(inverted)) {
        if (!Array.isArray(positions)) continue;
        for (const position of positions) {
            if (Number.isInteger(position)) slots[position] = word;
        }
    }
    const text = slots.filter((word) => typeof word === 'string').join(' ').trim();
    return text.length > 0 ? text : undefined;
}

/** Crossref abstracts and titles carry JATS markup. */
export function stripTags(value) {
    if (typeof value !== 'string') return undefined;
    return tidy(value
        .replace(/<jats:title>.*?<\/jats:title>/gis, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x?\d+;/g, ' '));
}

function firstString(value) {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
    return typeof value === 'string' ? value : undefined;
}

/**
 * Resolve a journal name or ISSN to an OpenAlex source, so a search can be
 * scoped to one journal instead of scraping the publisher's own site.
 * @param journal - journal title or ISSN.
 * @param options - transport settings.
 */
export async function resolveJournal(journal, options) {
    const trimmed = String(journal ?? '').trim();
    if (trimmed.length === 0) return undefined;
    const issn = trimmed.match(/\b(\d{4}-\d{3}[\dXx])\b/)?.[1];
    const { mailto, openalexApiKey, ...rest } = options;
    const params = new URLSearchParams({ 'per-page': '1' });
    if (issn) params.set('filter', `issn:${issn}`);
    else params.set('search', trimmed);
    if (mailto) params.set('mailto', mailto);
    if (openalexApiKey) params.set('api_key', openalexApiKey);
    const res = await request(`https://api.openalex.org/sources?${params}`, { ...rest, ua: userAgent(rest.version, mailto) });
    const hit = res.ok ? res.data?.results?.[0] : undefined;
    if (hit) {
        return {
            id: String(hit.id ?? '').split('/').pop(),
            name: tidy(hit.display_name),
            issn: Array.isArray(hit.issn_l) ? hit.issn_l[0] : hit.issn_l,
            source: 'openalex',
        };
    }
    // OpenAlex budget exhausted or no match: Crossref knows journals too, and
    // its ISSN lets the search filter by container title instead. Its fuzzy
    // match happily returns a different journal, so require an exact title.
    if (issn) {
        const direct = await request(`https://api.crossref.org/journals/${encodeURIComponent(issn)}`, { ...rest, ua: userAgent(rest.version, mailto) });
        if (direct.ok && direct.data?.message) {
            return { name: tidy(direct.data.message.title), issn, source: 'crossref' };
        }
    }
    const fallback = new URLSearchParams({ 'rows': '5' });
    if (issn) fallback.set('filter', `issn:${issn}`);
    else fallback.set('query', trimmed);
    if (mailto) fallback.set('mailto', mailto);
    const crossref = await request(`https://api.crossref.org/journals?${fallback}`, { ...rest, ua: userAgent(rest.version, mailto) });
    const candidates = crossref.ok && Array.isArray(crossref.data?.message?.items) ? crossref.data.message.items : [];
    const wanted = titleKey(trimmed);
    const journalHit = issn
        ? candidates.find((candidate) => (Array.isArray(candidate.ISSN) ? candidate.ISSN : [candidate.ISSN]).includes(issn))
        : candidates.find((candidate) => titleKey(candidate.title) === wanted);
    if (!journalHit) return undefined;
    return {
        name: tidy(journalHit.title),
        issn: Array.isArray(journalHit.ISSN) ? journalHit.ISSN[0] : journalHit.ISSN,
        source: 'crossref',
    };
}

function openAlexRecord(work) {
    const doi = normalizeDoi(work.doi);
    const locations = Array.isArray(work.locations) ? work.locations : [];
    const pdfUrls = [];
    const landingUrls = [];
    const licenses = [];
    for (const location of [work.best_oa_location, work.primary_location, ...locations]) {
        if (!location || typeof location !== 'object') continue;
        if (typeof location.pdf_url === 'string') pdfUrls.push(location.pdf_url);
        if (typeof location.landing_page_url === 'string') landingUrls.push(location.landing_page_url);
        if (typeof location.license === 'string') licenses.push(location.license);
    }
    const ids = work.ids ?? {};
    return {
        source: 'openalex',
        sources: ['openalex'],
        doi,
        title: tidy(work.display_name ?? work.title),
        titleKey: titleKey(work.display_name ?? work.title),
        authors: (work.authorships ?? [])
            .map((authorship) => authorship?.author?.display_name)
            .filter((name) => typeof name === 'string' && name.length > 0)
            .slice(0, 30),
        venue: tidy(work.primary_location?.source?.display_name),
        year: yearOf(work.publication_year),
        volume: work.biblio?.volume,
        issue: work.biblio?.issue,
        pages: work.biblio?.first_page ? `${work.biblio.first_page}-${work.biblio.last_page ?? ''}`.replace(/-$/, '') : undefined,
        abstract: reconstructAbstract(work.abstract_inverted_index),
        citedBy: Number.isFinite(work.cited_by_count) ? work.cited_by_count : undefined,
        type: work.type,
        arxivId: undefined,
        oa: {
            status: work.open_access?.oa_status ?? 'unknown',
            pdfUrls,
            landingUrls,
            licenses,
        },
    };
}

/**
 * OpenAlex search. Free; a contact address unlocks the polite pool.
 * @param query - free-text query.
 * @param options - limits, year window, contact address.
 */
export async function searchOpenAlex(query, options) {
    const { limit, yearFrom, yearTo, mailto, journalId, openalexApiKey, ...rest } = options;
    const params = new URLSearchParams({ search: query, 'per-page': String(limit) });
    const filters = [];
    if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
    if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
    if (journalId) filters.push(`primary_location.source.id:${journalId}`);
    if (filters.length > 0) params.set('filter', filters.join(','));
    if (mailto) params.set('mailto', mailto);
    if (openalexApiKey) params.set('api_key', openalexApiKey);
    const res = await request(`${OPENALEX_WORKS}?${params}`, { ...rest, ua: userAgent(rest.version, mailto) });
    if (!res.ok) return { source: 'openalex', works: [], error: res.error };
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    return { source: 'openalex', works: results.map(openAlexRecord).filter((record) => record.title) };
}

function crossrefRecord(item) {
    const doi = normalizeDoi(item.DOI);
    const pdfUrls = [];
    for (const link of item.link ?? []) {
        if (typeof link?.URL !== 'string') continue;
        if ((link['content-type'] ?? '').includes('pdf')) pdfUrls.push(link.URL);
    }
    const licenses = (item.license ?? []).map((license) => license?.URL).filter((url) => typeof url === 'string');
    const issued = item.issued?.['date-parts']?.[0]?.[0] ?? item.published?.['date-parts']?.[0]?.[0];
    return {
        source: 'crossref',
        sources: ['crossref'],
        doi,
        title: tidy(firstString(item.title)),
        titleKey: titleKey(firstString(item.title)),
        authors: (item.author ?? [])
            .map((author) => [author?.given, author?.family].filter(Boolean).join(' ') || author?.name)
            .filter((name) => typeof name === 'string' && name.length > 0)
            .slice(0, 30),
        venue: tidy(firstString(item['container-title'])),
        year: yearOf(issued),
        volume: item.volume,
        issue: item.issue,
        pages: item.page,
        abstract: stripTags(item.abstract),
        citedBy: Number.isFinite(item['is-referenced-by-count']) ? item['is-referenced-by-count'] : undefined,
        type: item.type,
        oa: { status: licenses.length > 0 ? 'unknown' : 'closed', pdfUrls, landingUrls: doi ? [`https://doi.org/${doi}`] : [], licenses },
    };
}

/**
 * Crossref search by bibliographic query.
 * @param query - free-text query.
 * @param options - limits, year window, contact address.
 */
export async function searchCrossref(query, options) {
    const { limit, yearFrom, yearTo, mailto, journalName, ...rest } = options;
    const params = new URLSearchParams({ query: query, rows: String(limit) });
    if (journalName) params.set('query.container-title', journalName);
    const filters = [];
    if (yearFrom) filters.push(`from-pub-date:${yearFrom}-01-01`);
    if (yearTo) filters.push(`until-pub-date:${yearTo}-12-31`);
    if (filters.length > 0) params.set('filter', filters.join(','));
    if (mailto) params.set('mailto', mailto);
    const res = await request(`${CROSSREF_WORKS}?${params}`, { ...rest, ua: userAgent(rest.version, mailto) });
    if (!res.ok) return { source: 'crossref', works: [], error: res.error };
    const items = Array.isArray(res.data?.message?.items) ? res.data.message.items : [];
    return { source: 'crossref', works: items.map(crossrefRecord).filter((record) => record.title) };
}

function xmlText(block, tag) {
    const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return match ? tidy(match[1]) : undefined;
}

function arxivRecord(entry) {
    const idUrl = xmlText(entry, 'id');
    const id = idUrl ? idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '') : undefined;
    const pdfHref = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/i)?.[1];
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)]
        .map((match) => tidy(match[1]))
        .filter(Boolean);
    const primary = xmlText(entry, 'arxiv:primary_category') ?? entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/i)?.[1];
    return {
        source: 'arxiv',
        sources: ['arxiv'],
        title: xmlText(entry, 'title'),
        titleKey: titleKey(xmlText(entry, 'title')),
        authors: authors.slice(0, 30),
        year: yearOf(xmlText(entry, 'published')),
        abstract: xmlText(entry, 'summary'),
        arxivId: id,
        type: primary,
        oa: {
            status: 'green',
            pdfUrls: id ? [`https://arxiv.org/pdf/${id}`] : (pdfHref ? [pdfHref] : []),
            landingUrls: id ? [`https://arxiv.org/abs/${id}`] : [],
            licenses: [],
        },
    };
}

/**
 * arXiv search. Free and keyless; the PDF is always reachable.
 * @param query - plain keywords, or raw arXiv syntax (`ti:`, `au:`, `cat:`, `AND`).
 * @param options - limits (arXiv pages by 100).
 */
export async function searchArxiv(query, options) {
    const { limit, ...rest } = options;
    const raw = /(^|\s)(ti|au|abs|cat|all|co|jr|rn):/i.test(query) || /\b(AND|OR|ANDNOT)\b/.test(query);
    const expression = raw ? query : `all:${query}`;
    const params = new URLSearchParams({
        search_query: expression,
        start: '0',
        max_results: String(limit),
        sortBy: 'relevance',
    });
    const res = await request(`${ARXIV_API}?${params}`, { ...rest, as: 'text', ua: userAgent(rest.version) });
    if (!res.ok) return { source: 'arxiv', works: [], error: res.error };
    const entries = [...res.data.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
    return { source: 'arxiv', works: entries.map(arxivRecord).filter((record) => record.title) };
}

function pubmedRecord(summary) {
    const ids = Array.isArray(summary.articleids) ? summary.articleids : [];
    const idOf = (type) => ids.find((entry) => (entry?.idtype ?? '').toLowerCase() === type)?.value;
    const doi = normalizeDoi(idOf('doi') ?? summary.elocationid);
    const pmid = idOf('pubmed') ?? (summary.uid ? String(summary.uid) : undefined);
    const pmcid = idOf('pmc');
    return {
        source: 'pubmed',
        sources: ['pubmed'],
        doi,
        title: tidy(summary.title),
        titleKey: titleKey(summary.title),
        authors: (summary.authors ?? []).map((author) => tidy(author?.name)).filter(Boolean).slice(0, 30),
        venue: tidy(summary.fulljournalname ?? summary.source),
        year: yearOf(summary.pubdate ?? summary.sortpubdate),
        pmid,
        pmcid,
        type: (summary.pubtype ?? [])[0],
        oa: {
            status: pmcid ? 'green' : 'unknown',
            pdfUrls: [],
            landingUrls: pmid ? [`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`] : [],
            licenses: [],
        },
    };
}

/**
 * NCBI E-utilities politeness parameters. An API key raises the ceiling from
 * 3 to 10 requests/second; `tool` and `email` identify the caller.
 * @param apiKey - optional NCBI API key.
 * @param mailto - optional contact address.
 */
function ncbiQuery(apiKey, mailto) {
    const extra = new URLSearchParams({ tool: 'dsh-literature' });
    if (apiKey) extra.set('api_key', apiKey);
    if (mailto) extra.set('email', mailto);
    return extra;
}

function mergeParams(target, extra) {
    for (const [name, value] of extra) target.set(name, value);
    return target;
}

/** Abstracts are not in esummary; one efetch call fills them in when it is cheap. */
async function pubmedAbstracts(pmids, options) {
    if (pmids.length === 0) return new Map();
    const { pubmedApiKey, mailto, ...rest } = options;
    const params = mergeParams(new URLSearchParams({ db: 'pubmed', id: pmids.join(','), retmode: 'xml' }), ncbiQuery(pubmedApiKey, mailto));
    const res = await request(`${NCBI}/efetch.fcgi?${params}`, { ...rest, as: 'text', ua: userAgent(rest.version) });
    if (!res.ok) return new Map();
    const out = new Map();
    for (const block of res.data.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) ?? []) {
        const pmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
        if (!pmid) continue;
        const parts = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((match) => stripTags(match[1]));
        const text = parts.filter(Boolean).join(' ');
        if (text) out.set(pmid, text);
    }
    return out;
}

/**
 * PubMed search: esearch for ids, esummary for records, efetch for abstracts.
 * @param query - PubMed syntax, including field tags.
 * @param options - limits, year window, and the optional NCBI key.
 */
export async function searchPubmed(query, options) {
    const { limit, yearFrom, yearTo, pubmedApiKey, mailto, ...rest } = options;
    const searchParams = mergeParams(
        new URLSearchParams({ db: 'pubmed', retmode: 'json', retmax: String(limit), term: query, sort: 'relevance' }),
        ncbiQuery(pubmedApiKey, mailto),
    );
    if (yearFrom || yearTo) {
        searchParams.set('datetype', 'pdat');
        searchParams.set('mindate', String(yearFrom ?? 1800));
        searchParams.set('maxdate', String(yearTo ?? new Date().getUTCFullYear()));
    }
    const search = await request(`${NCBI}/esearch.fcgi?${searchParams}`, { ...rest, ua: userAgent(rest.version) });
    if (!search.ok) return { source: 'pubmed', works: [], error: search.error };
    const idList = search.data?.esearchresult?.idlist;
    if (!Array.isArray(idList) || idList.length === 0) return { source: 'pubmed', works: [] };
    const summaryParams = mergeParams(new URLSearchParams({ db: 'pubmed', retmode: 'json', id: idList.join(',') }), ncbiQuery(pubmedApiKey, mailto));
    const summary = await request(`${NCBI}/esummary.fcgi?${summaryParams}`, { ...rest, ua: userAgent(rest.version) });
    if (!summary.ok) return { source: 'pubmed', works: [], error: summary.error };
    const result = summary.data?.result ?? {};
    const records = idList.map((id) => result[id]).filter(Boolean).map(pubmedRecord).filter((record) => record.title);
    const abstracts = await pubmedAbstracts(records.map((record) => record.pmid).filter(Boolean), { pubmedApiKey, mailto, ...rest });
    for (const record of records) {
        const abstract = record.pmid ? abstracts.get(record.pmid) : undefined;
        if (abstract) record.abstract = abstract;
    }
    return { source: 'pubmed', works: records };
}

function semanticRecord(paper) {
    const external = paper.externalIds ?? {};
    const doi = normalizeDoi(external.DOI);
    const arxivId = typeof external.ArXiv === 'string' ? external.ArXiv : undefined;
    const pdfUrl = paper.openAccessPdf?.url;
    return {
        source: 'semantic-scholar',
        sources: ['semantic-scholar'],
        doi,
        title: tidy(paper.title),
        titleKey: titleKey(paper.title),
        authors: (paper.authors ?? []).map((author) => tidy(author?.name)).filter(Boolean).slice(0, 30),
        venue: tidy(paper.venue),
        year: yearOf(paper.year),
        abstract: tidy(paper.abstract),
        citedBy: Number.isFinite(paper.citationCount) ? paper.citationCount : undefined,
        type: (paper.publicationTypes ?? [])[0],
        arxivId,
        pmid: external.PubMed ? String(external.PubMed) : undefined,
        oa: {
            status: paper.isOpenAccess ? 'green' : 'unknown',
            pdfUrls: typeof pdfUrl === 'string' ? [pdfUrl] : [],
            landingUrls: doi ? [`https://doi.org/${doi}`] : [],
            licenses: [],
        },
    };
}

/**
 * Semantic Scholar search. Works anonymously at ~1 request/second; an API key
 * (free, from the S2 portal) raises that and is read from a credential ref.
 *
 * S2 also throttles keyed callers with short bursts of 429, so one call is
 * repeated after a pause instead of being reported as a failure.
 * @param query - free-text query.
 * @param options - limits, year window, and the optional key.
 */
export async function searchSemanticScholar(query, options) {
    const { limit, yearFrom, yearTo, s2ApiKey, ...rest } = options;
    const params = new URLSearchParams({ query, limit: String(limit), fields: SEMANTIC_FIELDS });
    if (yearFrom || yearTo) params.set('year', `${yearFrom ?? 1800}-${yearTo ?? new Date().getUTCFullYear()}`);
    // Serialise calls: two parallel S2 queries from one process trip the limit.
    await s2Slot();
    let res;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        res = await request(`${SEMANTIC_SEARCH}?${params}`, {
            ...rest,
            ua: userAgent(rest.version),
            headers: s2ApiKey ? { 'x-api-key': s2ApiKey } : {},
        });
        if (res.ok) break;
        const throttled = /429/.test(String(res.error ?? ''));
        if (!throttled || attempt === 2) break;
        // 1.5s, then 3s: S2's window is short, and a retry usually succeeds.
        await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
    }
    if (!res.ok) return { source: 'semantic-scholar', works: [], error: res.error };
    const data = Array.isArray(res.data?.data) ? res.data.data : [];
    return { source: 'semantic-scholar', works: data.map(semanticRecord).filter((record) => record.title) };
}

/**
 * One PubMed record's display metadata, used to label a download that was
 * requested by PMID alone.
 * @param pmid - PubMed identifier.
 * @param options - key and contact address.
 */
export async function lookupTitleByPmid(pmid, options) {
    if (!pmid) return undefined;
    const { pubmedApiKey, mailto, ...rest } = options;
    const params = mergeParams(new URLSearchParams({ db: 'pubmed', retmode: 'json', id: String(pmid) }), ncbiQuery(pubmedApiKey, mailto));
    const res = await request(`${NCBI}/esummary.fcgi?${params}`, { ...rest, ua: userAgent(rest.version) });
    if (!res.ok) return undefined;
    const summary = res.data?.result?.[String(pmid)];
    if (!summary) return undefined;
    return { title: tidy(summary.title), year: yearOf(summary.pubdate ?? summary.sortpubdate), venue: tidy(summary.fulljournalname ?? summary.source), author: summary.authors?.[0]?.name };
}

/**
 * Display metadata for one arXiv id, so an arXiv-only download still gets a
 * year and a venue in its file name.
 * @param arxivId - arXiv identifier.
 * @param options - transport settings.
 */
export async function lookupArxivMeta(arxivId, options) {
    const id = String(arxivId).replace(/^arxiv:/i, '').replace(/v\d+$/, '').trim();
    if (!id) return undefined;
    const { mailto, ...rest } = options;
    const params = new URLSearchParams({ id_list: id, max_results: '1' });
    const res = await request(`https://export.arxiv.org/api/query?${params}`, { ...rest, as: 'text', ua: userAgent(rest.version) });
    if (!res.ok) return undefined;
    const entry = res.data.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
    if (!entry) return undefined;
    return {
        title: tidy(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
        year: yearOf(entry.match(/<published>([^<]+)<\/published>/i)?.[1]),
        venue: 'arXiv',
        author: tidy(entry.match(/<author>\s*<name>([\s\S]*?)<\/name>/i)?.[1]),
    };
}

const ADAPTERS = {
    openalex: searchOpenAlex,
    crossref: searchCrossref,
    arxiv: searchArxiv,
    pubmed: searchPubmed,
    'semantic-scholar': searchSemanticScholar,
};

/**
 * Run the requested adapters in parallel.
 * @param query - free-text query.
 * @param options - platform list plus shared transport options.
 * @returns one result per adapter, failures included.
 */
export async function searchAll(query, options) {
    const { sources, ...rest } = options;
    const selected = [...new Set(sources.filter((source) => ADAPTERS[source]))];
    const settled = await Promise.all(selected.map(async (source) => {
        try {
            return await ADAPTERS[source](query, rest);
        }
        catch (error) {
            return { source, works: [], error: error?.message ?? String(error) };
        }
    }));
    return settled;
}
