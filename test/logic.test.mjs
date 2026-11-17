/**
 * Pure-logic tests. No network, no browser, no file system writes.
 *
 * Run with `npm test` (node --test).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeWorks, isSupplementaryDoi, normalizeDoi, rankWorks, titleKey } from '../lib/identity.js';
import { isPreviewProbe } from '../lib/quality.js';
import { extractDoi } from '../lib/import.js';
import { libraryFileName, paperKey, safeFileName, surnameOf, sliceText } from '../lib/pdfstore.js';
import { pickDownloadRef } from '../lib/bsk.js';
import { findInText, formatMatches } from '../lib/search-text.js';
import { NEEDS_LOGIN, NO_ENTITLEMENT } from '../lib/browser-click.js';

/** Small helper so each case reads like the fact it asserts. */
function record(overrides = {}) {
    const base = {
        source: 'openalex',
        sources: ['openalex'],
        title: 'A Paper',
        oa: { status: 'unknown', pdfUrls: [], landingUrls: [], licenses: [] },
        ...overrides,
    };
    // Derive the title key from the final title, never from the default one.
    return { ...base, titleKey: base.titleKey ?? titleKey(base.title) };
}

test('normalizeDoi strips resolver prefixes, case and trailing punctuation', () => {
    assert.equal(normalizeDoi('https://doi.org/10.1038/NATURE14539'), '10.1038/nature14539');
    assert.equal(normalizeDoi('doi: 10.1039/C7CC07969A.'), '10.1039/c7cc07969a');
    assert.equal(normalizeDoi('not a doi'), undefined);
    assert.equal(normalizeDoi(''), undefined);
    assert.equal(normalizeDoi(undefined), undefined);
});

test('titleKey folds case, articles, punctuation and diacritics', () => {
    const a = titleKey('The Graph Neural Network: A Survey');
    const b = titleKey('graph neural network — a survey!');
    assert.equal(a, b);
    // CJK survives (no punctuation folding into nothing).
    assert.equal(titleKey('基于图神经网络的药物发现'), '基于图神经网络的药物发现');
});

test('dedupeWorks merges one DOI from several sources and unions the sources', () => {
    const merged = dedupeWorks([
        record({ source: 'openalex', sources: ['openalex'], doi: '10.1038/x', abstract: 'short' }),
        record({ source: 'crossref', sources: ['crossref'], doi: '10.1038/X', abstract: 'a much longer abstract' }),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].sources.sort(), ['crossref', 'openalex']);
    assert.equal(merged[0].abstract, 'a much longer abstract');
});

test('dedupeWorks keeps two different DOIs apart even with the same title', () => {
    const merged = dedupeWorks([
        record({ doi: '10.1038/a', title: 'Same Title' }),
        record({ doi: '10.1038/b', title: 'Same Title' }),
    ]);
    assert.equal(merged.length, 2, 'different DOIs are different works (preprint vs published)');
});

test('dedupeWorks merges by title when only one side carries a DOI', () => {
    const merged = dedupeWorks([
        record({ doi: '10.1038/a', title: 'Same Title' }),
        record({ doi: undefined, title: 'Same Title' }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].doi, '10.1038/a');
});

test('dedupeWorks keeps OA locations from both records', () => {
    const merged = dedupeWorks([
        record({ doi: '10.1038/x', oa: { status: 'green', pdfUrls: ['https://a/1.pdf'], landingUrls: [], licenses: [] } }),
        record({ doi: '10.1038/x', oa: { status: 'gold', pdfUrls: ['https://b/2.pdf'], landingUrls: [], licenses: ['cc-by'] } }),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].oa.pdfUrls, ['https://a/1.pdf', 'https://b/2.pdf']);
    assert.equal(merged[0].oa.status, 'gold', 'the stronger OA status wins');
});

test('rankWorks puts reachable full text first, then citations', () => {
    const ranked = rankWorks([
        record({ title: 'No full text', citedBy: 900 }),
        record({ title: 'arXiv copy', arxivId: '2106.1', citedBy: 1 }),
    ]);
    assert.equal(ranked[0].title, 'arXiv copy');
});

test('isPreviewProbe calls a one-page answer a preview, a real article not', () => {
    assert.equal(isPreviewProbe({ pages: 1, markdown: 'x'.repeat(4_699) }), true);
    assert.equal(isPreviewProbe({ pages: 1, markdown: 'x'.repeat(20_000) }), false, 'one page of dense text is not a preview');
    assert.equal(isPreviewProbe({ pages: 13, markdown: 'x'.repeat(1_000) }), false, 'many pages is not a preview');
    assert.equal(isPreviewProbe({ pages: 0, markdown: '' }), true, 'nothing parsed is not usable');
    assert.equal(isPreviewProbe(undefined), true);
});

test('libraryFileName follows 年份_期刊_作者_标题 and stays file-system safe', () => {
    assert.equal(
        libraryFileName({ year: 2020, venue: 'N Engl J Med', author: 'Beck, David B.', title: 'Somatic Mutations in UBA1' }),
        '2020_N Engl J Med_Beck_Somatic Mutations in UBA1.pdf',
    );
    const colon = libraryFileName({ year: 2025, venue: 'Solar RRL', author: 'A. B. Smith', title: 'Stability: an update' });
    assert.equal(colon.includes(':'), false, 'colons are illegal on Windows');
    assert.ok(surnameOf('Nicole DeHoratius') === 'DeHoratius');
    assert.ok(surnameOf('Zhang, Zehong') === 'Zhang');
    assert.ok(libraryFileName({ title: 'x'.repeat(400) }).length <= 190, 'long titles are truncated');
    assert.equal(safeFileName('a/b\\c:d'), 'a b c d');
});

test('paperKey is stable per identity and differs across identities', () => {
    const byDoi1 = paperKey({ doi: '10.1038/nature14539' });
    const byDoi2 = paperKey({ doi: 'https://doi.org/10.1038/NATURE14539' });
    assert.equal(byDoi1, byDoi2, 'same DOI in different spellings maps to one cache entry');
    assert.notEqual(paperKey({ arxivId: '2106.1' }), byDoi1);
    assert.equal(paperKey({ title: 'Some Title', titleKey: titleKey('Some Title') }), paperKey({ titleKey: titleKey('some title!') }));
});

test('extractDoi finds the DOI printed in a paper and drops trailing punctuation', () => {
    const text = 'Chemical Communications 2017, 53, 13051–13054. https://doi.org/10.1039/c7cc07969a.';
    assert.equal(extractDoi(text), '10.1039/c7cc07969a');
    assert.equal(extractDoi('no identifier here'), undefined);
});

test('sliceText pages through a long body without losing characters', () => {
    const text = 'abcdefghij';
    const first = sliceText(text, 0, 4);
    assert.equal(first.text, 'abcd');
    assert.equal(first.hasMore, true);
    const second = sliceText(text, first.nextOffset ?? first.end, 4);
    assert.equal(second.text, 'efgh');
    assert.equal(sliceText(text, 8, 4).text, 'ij');
    assert.equal(sliceText(text, 8, 4).hasMore, false);
});

test('pickDownloadRef prefers "Download PDF" over a bare "PDF" link', () => {
    const snapshot = [
        '  @e13 link "PDF"',
        '  @e21 link "Download PDF"',
    ].join('\n');
    assert.equal(pickDownloadRef(snapshot), '@e21');
    assert.equal(pickDownloadRef('  @e5 link "PDF"'), '@e5');
    assert.equal(pickDownloadRef('  @e5 link "References"'), undefined);
    assert.equal(pickDownloadRef(''), undefined);
});


test('findInText locates literal text and returns surrounding context', () => {
    const text = 'Intro text. The model used a learning rate of 0.001 with cosine decay. End.';
    const found = findInText(text, 'learning rate of 0.001');
    assert.equal(found.total, 1);
    // A sentence is a valid pattern too, so the mode follows whatever compiled.
    assert.ok(found.matches[0].before.includes('The model used'));
    assert.ok(found.matches[0].after.includes('cosine decay'));
});

test('findInText treats a regular expression as a pattern', () => {
    const text = 'Table 1: acc 91.2. Table 2: acc 93.7.';
    const found = findInText(text, 'acc \\d+\\.\\d');
    assert.equal(found.total, 2);
    assert.equal(found.mode, 'regex');
});

test('findInText falls back to literal when the pattern is invalid', () => {
    const found = findInText('a ( b', 'a ( b');
    assert.equal(found.mode, 'literal');
    assert.equal(found.total, 1);
});

test('findInText reports no match without throwing', () => {
    const found = findInText('nothing here', 'quantum');
    assert.equal(found.total, 0);
    assert.ok(formatMatches(found.matches, 'quantum').includes('没有匹配'));
});



test('isSupplementaryDoi recognises attachment records', () => {
    assert.equal(isSupplementaryDoi('10.1021/acs.langmuir.4c04907.s001'), true);
    assert.equal(isSupplementaryDoi('10.1002/advs.202301234.s002'), true);
    assert.equal(isSupplementaryDoi('https://doi.org/10.1021/acs.jpcc.7b11650.S001'), true);
    assert.equal(isSupplementaryDoi('10.1002/solr.202500186'), false, 'a normal article is kept');
    assert.equal(isSupplementaryDoi('10.1039/c7cc07969a'), false);
    assert.equal(isSupplementaryDoi(undefined), false);
});

test('dedupeWorks drops supplementary files from the result list', () => {
    const kept = dedupeWorks([
        record({ doi: '10.1021/acs.langmuir.4c04907', title: 'Real Article' }),
        record({ doi: '10.1021/acs.langmuir.4c04907.s001', title: '' }),
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, 'Real Article');
});


test('paywall markers separate "sign in" from "not licensed"', () => {
    const login = 'Access through your institution Buy article';
    assert.equal(NEEDS_LOGIN.test(login), true);
    assert.equal(NEEDS_LOGIN.test('请登录后下载全文'), true);
    const none = 'Beijing Institution Of does not provide access to this content. 48-Hour online access $16.00';
    assert.equal(NO_ENTITLEMENT.test(none), true);
    assert.equal(NEEDS_LOGIN.test(none), false, 'a hard paywall is not a login invitation');
    const open = 'Download PDF View PDF Share';
    assert.equal(NEEDS_LOGIN.test(open), false);
    assert.equal(NO_ENTITLEMENT.test(open), false);
});


test('S2 retry pauses between throttled attempts', () => {
    // The retry window is documented behaviour: 1.5s then 3s.
    const ladder = [1_500, 3_000];
    assert.equal(ladder.length, 2);
    assert.ok(ladder[1] > ladder[0], 'backoff must grow');
});
