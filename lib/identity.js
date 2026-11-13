/**
 * Paper identity: DOI normalisation, a stable title key, and the de-duplication
 * pass that turns per-platform result lists into one ranked list.
 * @module dsh-literature/identity
 */

const TRAILING_NOISE = /[)\]>,.;:'"”’\s]+$/;
const LEADING_ARTICLES = /^(a|an|the|der|die|das|le|la|les|el|los|un|une)\s+/;

/**
 * Canonical DOI: no resolver prefix, lowercase, no trailing punctuation.
 * @param raw - DOI as printed, as a URL, or with a `doi:` label.
 */
export function normalizeDoi(raw) {
    if (typeof raw !== 'string') return undefined;
    let value = raw.trim();
    if (value.length === 0) return undefined;
    value = value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    value = value.replace(/^doi:\s*/i, '');
    value = value.replace(TRAILING_NOISE, '');
    value = value.toLowerCase();
    return /^10\.\d{4,9}\/\S+$/.test(value) ? value : undefined;
}

/**
 * Stable comparison key for a title: diacritics folded, punctuation dropped,
 * CJK preserved, leading articles removed.
 * @param raw - the title.
 */
export function titleKey(raw) {
    if (typeof raw !== 'string') return undefined;
    const folded = raw
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/<[^>]+>/g, ' ')
        .toLowerCase();
    const kept = folded.replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, ' ').trim();
    const stripped = kept.replace(LEADING_ARTICLES, '').replace(/\s+/g, ' ');
    if (stripped.length === 0) return undefined;
    return stripped.slice(0, 160);
}

/** First four-digit year in a value, tolerating `2021-05-03` and `2021 May`. */
export function yearOf(value) {
    if (typeof value === 'number' && value >= 1500 && value <= 2200) return value;
    if (typeof value !== 'string') return undefined;
    const match = value.match(/(1[5-9]\d{2}|20\d{2}|21\d{2})/);
    return match ? Number(match[1]) : undefined;
}

const OA_RANK = { gold: 5, hybrid: 4, green: 3, bronze: 2, diamond: 5, closed: 0, unknown: 1 };

function longer(a, b) {
    if (!a) return b;
    if (!b) return a;
    return b.length > a.length ? b : a;
}

function earlier(a, b) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(a, b);
}

function bigger(a, b) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
}

/** Union of two URL lists, order preserved. */
function unionUrls(a = [], b = []) {
    const seen = new Set();
    const out = [];
    for (const url of [...a, ...b]) {
        if (typeof url !== 'string' || url.length === 0) continue;
        const key = url.replace(/[#?].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(url);
    }
    return out;
}

function unionStrings(a = [], b = []) {
    return [...new Set([...a, ...b].filter((value) => typeof value === 'string' && value.length > 0))];
}

/**
 * Merge two records of the same paper, keeping the richer field per slot.
 * @param left - existing record.
 * @param right - incoming record.
 */
export function mergeRecord(left, right) {
    const oaStatus = OA_RANK[right?.oa?.status] > OA_RANK[left?.oa?.status] ? right.oa.status : left.oa.status;
    return {
        ...left,
        title: longer(left.title, right.title),
        authors: (right.authors?.length ?? 0) > (left.authors?.length ?? 0) ? right.authors : left.authors,
        venue: left.venue ?? right.venue,
        year: earlier(left.year, right.year),
        abstract: longer(left.abstract, right.abstract),
        citedBy: bigger(left.citedBy, right.citedBy),
        doi: left.doi ?? right.doi,
        arxivId: left.arxivId ?? right.arxivId,
        pmid: left.pmid ?? right.pmid,
        pmcid: left.pmcid ?? right.pmcid,
        type: left.type ?? right.type,
        sources: unionStrings(left.sources, right.sources),
        oa: {
            status: oaStatus ?? 'unknown',
            pdfUrls: unionUrls(left.oa?.pdfUrls, right.oa?.pdfUrls),
            landingUrls: unionUrls(left.oa?.landingUrls, right.oa?.landingUrls),
            licenses: unionStrings(left.oa?.licenses, right.oa?.licenses),
        },
    };
}

/**
 * Whether a DOI points at a supplementary file rather than the article itself.
 *
 * Crossref lists these as separate records (`10.1021/acs.langmuir.4c04907.s001`),
 * which are attachments: a reader cannot cite them and they carry no abstract.
 * @param doi - a DOI, with or without the resolver prefix.
 */
export function isSupplementaryDoi(doi) {
    const value = typeof doi === 'string' ? doi.trim().toLowerCase() : '';
    if (value.length === 0) return false;
    // ACS / Wiley style: …c04907.s001, …202301234.s002
    if (/\.s\d{3,4}$/.test(value)) return true;
    // Publisher style: …-sup-0001, …suppl_1, …-supplementary
    if (/(?:^|[-_/])(?:sup|supp|suppl|supplementary)(?:[-_.]?\d{1,4})?$/.test(value)) return true;
    return false;
}

/**
 * Collapse per-platform results into one list. Records join on DOI first and on
 * the title key second; two different DOIs never merge, so a publisher version
 * and a preprint stay distinct rows.
 * @param works - records from any number of adapters.
 * @returns merged records in first-seen order, each carrying `sources`.
 */
export function dedupeWorks(works) {
    const byDoi = new Map();
    const byTitle = new Map();
    const order = [];
    for (const raw of works) {
        if (!raw || typeof raw !== 'object') continue;
        // Crossref lists supplementary files as their own records; they are
        // attachments, not articles, so they never enter the result list.
        if (isSupplementaryDoi(raw.doi)) continue;
        const doi = normalizeDoi(raw.doi);
        const key = titleKey(raw.title);
        const record = {
            ...raw,
            doi,
            titleKey: key,
            sources: unionStrings(raw.sources ?? [raw.source]),
            oa: {
                status: raw.oa?.status ?? 'unknown',
                pdfUrls: unionUrls(raw.oa?.pdfUrls),
                landingUrls: unionUrls(raw.oa?.landingUrls),
                licenses: unionStrings(raw.oa?.licenses),
            },
        };
        const doiHit = doi ? byDoi.get(doi) : undefined;
        const titleHit = key ? byTitle.get(key) : undefined;
        // Two records that each carry a DIFFERENT DOI are different works (a preprint
        // and the published version), so the title must not merge them. A record with
        // no DOI of its own still merges into the title match.
        const conflict = Boolean(doi && titleHit?.doi && titleHit.doi !== doi);
        const target = doiHit ?? (conflict ? undefined : titleHit);
        if (!target) {
            order.push(record);
            if (doi) byDoi.set(doi, record);
            if (key) byTitle.set(key, record);
            continue;
        }
        const merged = mergeRecord(target, record);
        merged.titleKey = target.titleKey ?? key;
        for (const [d, entry] of byDoi) if (entry === target) byDoi.set(d, merged);
        for (const [t, entry] of byTitle) if (entry === target) byTitle.set(t, merged);
        order[order.indexOf(target)] = merged;
        if (merged.doi) byDoi.set(merged.doi, merged);
        if (merged.titleKey) byTitle.set(merged.titleKey, merged);
    }
    return order;
}

/**
 * Sort merged records: reachable full text first, then citations, then year.
 * @param records - merged records.
 */
export function rankWorks(records) {
    const reach = (record) => (record.arxivId ? 3 : record.pmcid ? 2 : record.oa?.pdfUrls?.length ? 1 : 0);
    return [...records].sort((a, b) => {
        const diff = reach(b) - reach(a);
        if (diff !== 0) return diff;
        return (b.citedBy ?? 0) - (a.citedBy ?? 0) || (b.year ?? 0) - (a.year ?? 0);
    });
}
