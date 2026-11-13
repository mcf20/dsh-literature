/**
 * The open-access resolution chain: given a DOI / arXiv id / PMID, ask every
 * free oracle where a legal copy lives, and rank what comes back.
 * @module dsh-literature/fulltext
 */
import { normalizeDoi } from './identity.js';
import { request, tidy, userAgent, viaEzproxy } from './net.js';

const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const UNPAYWALL = 'https://api.unpaywall.org/v2';
const OPENALEX_WORKS = 'https://api.openalex.org/works';
const SEMANTIC = 'https://api.semanticscholar.org/graph/v1/paper';
const CORE = 'https://api.core.ac.uk/v3/search/works';

/** Higher wins when two candidates point at the same paper. */
const TRUST = { arxiv: 100, pmc: 90, unpaywall: 80, openalex: 70, semanticscholar: 60, core: 55 };

function candidate(source, url, extra = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return undefined;
    return { source, url, trust: TRUST[source] ?? 10, kind: 'pdf', ...extra };
}

/** arXiv always has a PDF and always makes it legal to read. */
function fromArxiv(arxivId) {
    if (!arxivId) return [];
    const id = String(arxivId).replace(/^arxiv:/i, '').replace(/v\d+$/, '');
    return [
        candidate('arxiv', `https://arxiv.org/pdf/${id}`, { kind: 'pdf', license: 'arXiv license', version: 'preprint', guaranteed: true }),
    ];
}

/** Europe PMC reports the OA subset with per-URL availability codes. */
async function fromEuropePmc({ pmid, pmcid, doi }, transport) {
    const term = pmid ? `EXT_ID:${pmid} AND SRC:MED` : pmcid ? `PMCID:${pmcid}` : doi ? `DOI:"${doi}"` : undefined;
    if (!term) return { works: [], attempts: [] };
    const params = new URLSearchParams({ query: term, format: 'json', resultType: 'core', pageSize: '5' });
    const res = await request(`${EUROPE_PMC}?${params}`, { ...transport, ua: userAgent(transport.version) });
    if (!res.ok) return { works: [], attempts: [{ source: 'europepmc', ok: false, note: res.error }] };
    const hits = res.data?.resultList?.result ?? [];
    const out = [];
    for (const hit of hits) {
        const pmc = hit.pmcid ?? pmcid;
        if (pmc) {
            out.push(candidate('pmc', `https://europepmc.org/articles/${pmc}?pdf=render`, { kind: 'pdf', license: hit.license, version: 'published', oaCode: 'pmc' }));
            out.push(candidate('pmc', `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc}/pdf/`, { kind: 'pdf', license: hit.license, version: 'published', oaCode: 'pmc-ncbi' }));
        }
        for (const entry of hit.fullTextUrlList?.fullTextUrl ?? []) {
            if (!/pdf/i.test(`${entry.documentStyle} ${entry.url}`)) continue;
            out.push(candidate('pmc', entry.url, { kind: 'pdf', license: hit.license, version: entry.documentStyle ?? 'published', oaCode: entry.availabilityCode }));
        }
    }
    return { works: out, attempts: [{ source: 'europepmc', ok: true, note: `${hits.length} hit(s)` }] };
}

/** Unpaywall is the canonical OA oracle and needs a contact address. */
async function fromUnpaywall(doi, email, transport) {
    if (!doi || !email) return { works: [], attempts: [{ source: 'unpaywall', ok: false, note: email ? 'no DOI' : 'needs unpaywallEmail' }] };
    const res = await request(`${UNPAYWALL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, { ...transport, ua: userAgent(transport.version, email) });
    if (!res.ok) return { works: [], attempts: [{ source: 'unpaywall', ok: false, note: res.error }] };
    const locations = Array.isArray(res.data?.oa_locations) ? res.data.oa_locations : [];
    const out = [];
    for (const location of locations) {
        const url = location.url_for_pdf ?? location.url;
        if (typeof url !== 'string') continue;
        // A handle or repository page is not a file: mark it so the fetch stage
        // can open it in the browser and read the real download link.
        const isFile = /\.pdf(\?|#|$)/i.test(url) || /sciencedirectassets|\.pdf\//i.test(url);
        out.push(candidate('unpaywall', url, {
            kind: isFile ? 'pdf' : 'landing',
            license: location.license,
            version: location.version,
            oaStatus: location.host_type,
        }));
    }
    return { works: out, attempts: [{ source: 'unpaywall', ok: true, note: `${locations.length} OA location(s)` }] };
}

/** OpenAlex repeats the OA locations it already knows about. */
async function fromOpenAlex(doi, mailto, transport) {
    if (!doi) return { works: [], attempts: [] };
    const params = new URLSearchParams();
    if (mailto) params.set('mailto', mailto);
    if (transport.openalexApiKey) params.set('api_key', transport.openalexApiKey);
    const suffix = params.toString() ? `?${params}` : '';
    const res = await request(`${OPENALEX_WORKS}/https://doi.org/${encodeURIComponent(doi)}${suffix}`, { ...transport, ua: userAgent(transport.version, mailto) });
    if (!res.ok) return { works: [], attempts: [{ source: 'openalex', ok: false, note: res.error }] };
    const locations = Array.isArray(res.data?.locations) ? res.data.locations : [];
    const out = [];
    for (const location of locations) {
        if (typeof location.pdf_url !== 'string') continue;
        out.push(candidate('openalex', location.pdf_url, {
            kind: 'pdf',
            license: location.license,
            version: location.version,
            oaStatus: res.data?.open_access?.oa_status,
        }));
    }
    return { works: out, attempts: [{ source: 'openalex', ok: true, note: `${out.length} PDF location(s)` }] };
}

/** Semantic Scholar's own OA verdict, useful when the others disagree. */
async function fromSemanticScholar(doi, apiKey, transport) {
    if (!doi) return { works: [], attempts: [] };
    const fields = 'openAccessPdf,isOpenAccess,externalIds,title';
    const res = await request(`${SEMANTIC}/DOI:${encodeURIComponent(doi)}?fields=${fields}`, {
        ...transport,
        ua: userAgent(transport.version),
        headers: apiKey ? { 'x-api-key': apiKey } : {},
    });
    if (!res.ok) return { works: [], attempts: [{ source: 'semanticscholar', ok: false, note: res.error }] };
    const pdf = res.data?.openAccessPdf?.url;
    const out = [];
    const hit = candidate('semanticscholar', pdf, { kind: 'pdf', license: res.data?.openAccessPdf?.license, version: res.data?.openAccessPdf?.status });
    if (hit) out.push(hit);
    return { works: out, attempts: [{ source: 'semanticscholar', ok: true, note: res.data?.isOpenAccess ? 'OA' : 'no OA copy' }] };
}

/** CORE aggregates institutional repositories; it needs a key. */
async function fromCore(doi, apiKey, transport) {
    if (!doi || !apiKey) return { works: [], attempts: apiKey ? [] : [{ source: 'core', ok: false, note: 'no CORE key' }] };
    const params = new URLSearchParams({ q: `doi:"${doi}"`, limit: '5' });
    const res = await request(`${CORE}?${params}`, {
        ...transport,
        ua: userAgent(transport.version),
        headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { works: [], attempts: [{ source: 'core', ok: false, note: res.error }] };
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    const out = [];
    for (const result of results) {
        out.push(candidate('core', result.downloadUrl, { kind: 'pdf', license: result.license, version: 'repository' }));
    }
    return { works: out, attempts: [{ source: 'core', ok: true, note: `${out.length} repository copy(ies)` }] };
}

/** True when the deployment can reach entitled publisher content. */
function hasInstitutional(transport) {
    return Boolean(transport?.institutionalProxy || transport?.ezproxyPrefix);
}

const ELSEVIER_TDM = 'https://api.elsevier.com/content/article/doi';

/**
 * Elsevier's official text-and-data-mining endpoint. It serves the publisher's
 * own PDF for entitled institutions, so it needs no browser and no scraping —
 * only the API key and the subscription your network already carries.
 * @param doi - canonical DOI.
 * @param apiKey - Elsevier API key.
 */
function fromElsevier(doi, apiKey) {
    if (!doi) return { works: [], attempts: [] };
    // Elsevier owns a small set of DOI prefixes; asking for anything else is a
    // guaranteed 404 and merely wastes an attempt slot.
    if (!/^10\.(1016|1014|1053|1054|1067|1006|1010|1011|1385|1359)\//i.test(doi)) {
        return { works: [], attempts: [] };
    }
    if (!apiKey) return { works: [], attempts: [{ source: 'elsevier', ok: false, note: 'no Elsevier key' }] };
    const url = `${ELSEVIER_TDM}/${encodeURIComponent(doi)}?httpAccept=application/pdf`;
    return {
        works: [candidate('elsevier', url, {
            kind: 'pdf',
            license: 'institutional-tdm',
            version: 'published',
            trust: 92,
            headers: { 'x-els-apikey': apiKey, accept: 'application/pdf' },
        })],
        attempts: [{ source: 'elsevier', ok: true, note: 'TDM endpoint (official)' }],
    };
}

/**
 * Publisher-specific PDF routes. A DOI resolves to a landing page; each
 * publisher then exposes its PDF at a predictable path, and entitled access
 * decides whether that path answers with bytes or a login page.
 * @param landing - final landing URL after the DOI redirect.
 * @param html - landed HTML, used to recover IEEE `arnumber` and Elsevier PII.
 * @param doi - canonical DOI, for the path-per-DOI publishers.
 */
function publisherPdfRoutes(landing, html, doi) {
    let host = '';
    try {
        host = new URL(landing).hostname.toLowerCase();
    }
    catch {
        host = '';
    }
    // IEEE and Elsevier register DOIs that resolve through Crossref, so the
    // landing host says nothing; scan the page text for the publisher instead.
    const haystack = `${landing} ${(html ?? '').slice(0, 40_000)}`.toLowerCase();
    const routes = [];
    const arnumber = html?.match(/arnumber[=%3D]*(\d{5,})/i)?.[1] ?? landing.match(/document\/(\d{5,})/)?.[1];
    if (arnumber && /ieee|xplore/.test(`${host} ${haystack}`)) {
        routes.push(`https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}`);
        routes.push(`https://ieeexplore.ieee.org/ielx7/${arnumber}.pdf`);
    }
    // Match the host only: page chrome mentions other publishers in navigation
    // and footers, which produced bogus routes for the wrong publisher.
    const matches = (needle) => host.includes(needle);
    if (matches('springer')) routes.push(`https://link.springer.com/content/pdf/${doi}.pdf`);
    if (matches('wiley')) routes.push(`https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}`);
    if (matches('pubs.acs.org')) routes.push(`https://pubs.acs.org/doi/pdf/${doi}`);
    if (matches('tandfonline')) routes.push(`https://www.tandfonline.com/doi/pdf/${doi}`);
    if (matches('dl.acm.org')) routes.push(`https://dl.acm.org/doi/pdf/${doi}`);
    if (matches('science.org')) routes.push(`https://www.science.org/doi/pdf/${doi}`);
    if (matches('pnas.org')) routes.push(`https://www.pnas.org/doi/pdf/${doi}`);
    if (matches('nature.com')) routes.push(`https://www.nature.com/articles/${String(doi).split('/').pop()}.pdf`);
    // RSC encodes the year and journal in the DOI suffix: c7cc07969a → 2017 /
    // cc / c7cc07969a, served from /en/content/articlepdf/<year>/<journal>/<suffix>.
    if (matches('rsc.org')) {
        const suffix = String(doi).split('/').pop() ?? '';
        const parts = suffix.match(/^([cd])(\d)([a-z]{2})\d{5}[a-z]$/i);
        if (parts) {
            const year = (parts[1].toLowerCase() === 'c' ? 2010 : 2020) + Number(parts[2]);
            routes.push(`https://pubs.rsc.org/en/content/articlepdf/${year}/${parts[3].toLowerCase()}/${suffix}`);
        }
    }
    if (matches('iopscience')) routes.push(`https://iopscience.iop.org/article/${doi}/pdf`);
    if (matches('jstor')) routes.push(`https://www.jstor.org/stable/pdf/${doi}.pdf`);
    return routes;
}

/**
 * Publisher PDFs advertise themselves with a `citation_pdf_url` meta tag. This
 * is the precise, standards-based way to find the PDF behind a DOI; it only
 * succeeds when the request carries the reader's own subscription.
 */
async function fromCitationPdf(doi, transport) {
    if (!doi || !hasInstitutional(transport)) return { works: [], attempts: [] };
    const target = viaEzproxy(`https://doi.org/${doi}`, transport.ezproxyPrefix);
    const res = await request(target, { ...transport, as: 'text', timeoutMs: 20_000, retries: 1 });
    if (!res.ok) return { works: [], attempts: [{ source: 'publisher', ok: false, note: res.error }] };
    const patterns = [
        /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i,
    ];
    const url = patterns.map((pattern) => res.data.match(pattern)?.[1]).find(Boolean);
    const out = [];
    if (url) {
        const absolute = new URL(url, res.finalUrl ?? target).toString();
        out.push(candidate('publisher', viaEzproxy(absolute, transport.ezproxyPrefix), {
            kind: 'pdf',
            license: 'institutional',
            version: 'published',
            trust: 86,
        }));
    }
    for (const route of publisherPdfRoutes(res.finalUrl ?? target, res.data, doi)) {
        out.push(candidate('publisher', viaEzproxy(route, transport.ezproxyPrefix), {
            kind: 'pdf',
            license: 'institutional',
            version: 'published',
            trust: 84,
        }));
    }
    return {
        works: out.filter(Boolean),
        attempts: [{
            source: 'publisher',
            ok: true,
            note: [url ? 'citation_pdf_url' : 'no citation_pdf_url', `${out.length} route(s)`].join(' · '),
        }],
    };
}

/** Crossref records sometimes carry the publisher's own PDF/TDM link. */
async function fromCrossrefLinks(doi, transport) {
    if (!doi || !hasInstitutional(transport)) return { works: [], attempts: [] };
    const res = await request(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { ...transport, ua: userAgent(transport.version) });
    if (!res.ok) return { works: [], attempts: [{ source: 'crossref-links', ok: false, note: res.error }] };
    const links = Array.isArray(res.data?.message?.link) ? res.data.message.link : [];
    const out = [];
    for (const link of links) {
        if (!/pdf/i.test(`${link?.['content-type'] ?? ''} ${link?.URL ?? ''}`)) continue;
        out.push(candidate('publisher', viaEzproxy(link.URL, transport.ezproxyPrefix), {
            kind: 'pdf',
            license: 'institutional',
            version: 'published',
            trust: 80,
        }));
    }
    // Elsevier carries the ScienceDirect PII as `alternative-id`; the reader
    // page route below is the one an entitled browser hits.
    const altIds = Array.isArray(res.data?.message?.['alternative-id']) ? res.data.message['alternative-id'] : [];
    const pii = altIds.map(String).find((id) => /^S[\dX()-]{10,}$/i.test(id));
    if (pii) {
        out.push(candidate('publisher', viaEzproxy(`https://www.sciencedirect.com/science/article/pii/${pii}/pdfft?isDTMRedir=true&download=true`, transport.ezproxyPrefix), {
            kind: 'pdf',
            license: 'institutional',
            version: 'published',
            trust: 83,
        }));
    }
    return { works: out, attempts: [{ source: 'crossref-links', ok: true, note: `${out.length} publisher link(s)` }] };
}

/** Collapse duplicate URLs, keeping the most trusted description of each. */
function rankCandidates(candidates) {
    const seen = new Map();
    for (const entry of candidates) {
        if (!entry) continue;
        const key = entry.url.replace(/\/+$/, '').toLowerCase();
        const existing = seen.get(key);
        if (!existing || entry.trust > existing.trust) seen.set(key, entry);
    }
    return [...seen.values()].sort((a, b) => b.trust - a.trust);
}

/**
 * Ask OpenAlex for a DOI's display metadata, so a download can be labelled with
 * a real title instead of a hash.
 * @param doi - canonical DOI.
 * @param options - contact address and transport settings.
 */
export async function lookupTitleByDoi(doi, options) {
    const { mailto, ...transport } = options;
    if (!doi) return undefined;
    const params = new URLSearchParams();
    if (mailto) params.set('mailto', mailto);
    if (transport.openalexApiKey) params.set('api_key', transport.openalexApiKey);
    const suffix = params.toString() ? `?${params}` : '';
    const res = await request(`${OPENALEX_WORKS}/https://doi.org/${encodeURIComponent(doi)}${suffix}`, { ...transport, ua: userAgent(transport.version, mailto) });
    if (!res.ok) return undefined;
    return {
        title: tidy(res.data?.display_name),
        year: res.data?.publication_year,
        venue: tidy(res.data?.primary_location?.source?.display_name),
        author: res.data?.authorships?.[0]?.author?.display_name,
    };
}

/** Ask OpenAlex for the DOI of a title-only request. */export async function lookupDoiByTitle(title, { mailto, ...transport }) {
    const params = new URLSearchParams({ search: title, 'per-page': '3' });
    if (mailto) params.set('mailto', mailto);
    const res = await request(`${OPENALEX_WORKS}?${params}`, { ...transport, ua: userAgent(transport.version, mailto) });
    if (!res.ok) return { attempts: [{ source: 'openalex-title', ok: false, note: res.error }] };
    const hit = (res.data?.results ?? []).find((work) => typeof work.doi === 'string');
    if (!hit) return { attempts: [{ source: 'openalex-title', ok: true, note: 'no DOI match' }] };
    return {
        doi: normalizeDoi(hit.doi),
        title: tidy(hit.display_name),
        year: hit.publication_year,
        attempts: [{ source: 'openalex-title', ok: true, note: 'matched by title' }],
    };
}

/**
 * Resolve every reachable full-text candidate for one paper.
 * @param input - identifiers; a title alone is resolved through OpenAlex.
 * @param options - contact addresses, CORE key, transport settings.
 */
export async function resolveFulltext(input, options) {
    const { mailto, unpaywallEmail, coreApiKey, semanticScholarApiKey, elsevierApiKey, ...transport } = options;    let { doi, arxivId, pmid, pmcid, title } = input;
    doi = normalizeDoi(doi);
    const attempts = [];
    if (!doi && !arxivId && !pmid && !pmcid && title) {
        const lookup = await lookupDoiByTitle(title, { mailto, ...transport });
        doi = lookup.doi;
        attempts.push(...lookup.attempts);
        if (!doi) return { doi: undefined, arxivId, pmid, pmcid, candidates: [], attempts };
    }
    const [epmc, unpaywall, openalex, s2, core, citation, crossrefLinks, elsevier] = await Promise.all([
        fromEuropePmc({ pmid, pmcid, doi }, transport).catch(() => ({ works: [], attempts: [] })),
        fromUnpaywall(doi, unpaywallEmail ?? mailto, transport).catch(() => ({ works: [], attempts: [] })),
        fromOpenAlex(doi, mailto, transport).catch(() => ({ works: [], attempts: [] })),
        fromSemanticScholar(doi, semanticScholarApiKey, transport).catch(() => ({ works: [], attempts: [] })),
        fromCore(doi, coreApiKey, transport).catch(() => ({ works: [], attempts: [] })),
        fromCitationPdf(doi, transport).catch(() => ({ works: [], attempts: [] })),
        fromCrossrefLinks(doi, transport).catch(() => ({ works: [], attempts: [] })),
        Promise.resolve(fromElsevier(doi, elsevierApiKey)),
    ]);
    for (const part of [epmc, unpaywall, openalex, s2, core, citation, crossrefLinks, elsevier]) attempts.push(...part.attempts);
    const candidates = rankCandidates([
        ...fromArxiv(arxivId),
        ...elsevier.works,
        ...epmc.works,
        ...unpaywall.works,
        ...openalex.works,
        ...s2.works,
        ...core.works,
        ...citation.works,
        ...crossrefLinks.works,
    ]);
    return { doi, arxivId, pmid, pmcid, candidates, attempts };
}
