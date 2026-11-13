/**
 * Browser hand-off. Publisher, PMC and repository PDF routes answer a plain
 * HTTP client with 403/502 because it is not a browser; they answer a real
 * Chrome, on campus, because it is. This module drives the user's own Chrome
 * over the DevTools Protocol: it launches the browser when needed, reuses one
 * tab, and captures the response body of the PDF navigation.
 *
 * Zero dependencies: Node's global WebSocket and fetch speak CDP directly.
 * @module dsh-literature/browser
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikePdf } from './net.js';

const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
];

/** First existing Chrome binary, or undefined. */
export function findChrome() {
    return CHROME_CANDIDATES.find((path) => path && existsSync(path));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint(port, path) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: path.startsWith('/json/new') ? 'PUT' : 'GET' });
    if (!res.ok) throw new Error(`CDP ${path} -> HTTP ${res.status}`);
    return res.json();
}

/**
 * Whether a debugging endpoint is already listening.
 * @param port - CDP port.
 */
export async function isBrowserUp(port) {
    try {
        const info = await endpoint(port, '/json/version');
        return typeof info?.webSocketDebuggerUrl === 'string';
    }
    catch {
        return false;
    }
}

let launched;

/**
 * Start Chrome with a debugging port on a dedicated profile, or reuse one that
 * is already listening. The dedicated profile keeps the user's own browser
 * untouched; on a campus network the egress IP is what carries access.
 * @param options - port, profile directory, optional explicit binary.
 */
export async function ensureBrowser(options) {
    const { port, userDataDir, chromePath, timeoutMs = 20_000, direct = true } = options;
    if (await isBrowserUp(port)) return { port, launched: false };
    const binary = chromePath && existsSync(chromePath) ? chromePath : findChrome();
    if (!binary) throw new Error('Chrome not found; set chromePath in the plugin config');
    if (!launched) {
        await mkdir(userDataDir, { recursive: true });
        const args = [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate',
        ];
        // Publisher access is decided by the egress IP: the campus address is the
        // subscription. The local proxy exits elsewhere, so the browser goes
        // direct while the metadata calls keep using the proxy.
        if (direct) args.push('--no-proxy-server');
        args.push('about:blank');
        launched = spawn(binary, args, { detached: true, stdio: 'ignore' });
        launched.unref();
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isBrowserUp(port)) return { port, launched: true };
        await sleep(300);
    }
    throw new Error(`Chrome did not expose a debugging port on ${port} within ${timeoutMs} ms`);
}

/** Minimal CDP client over one target's WebSocket. */
export class Cdp {
    constructor(url) {
        this.url = url;
        this.nextId = 0;
        this.pending = new Map();
        this.handlers = new Set();
        this.closed = false;
    }

    async open(timeoutMs = 10_000) {
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(this.url);
            this.socket = socket;
            const timer = setTimeout(() => reject(new Error('CDP socket timeout')), timeoutMs);
            socket.onopen = () => {
                clearTimeout(timer);
                resolve();
            };
            socket.onerror = () => {
                clearTimeout(timer);
                reject(new Error('CDP socket error'));
            };
            socket.onmessage = (event) => {
                let message;
                try {
                    message = JSON.parse(event.data);
                }
                catch {
                    return;
                }
                if (typeof message.id === 'number') {
                    const entry = this.pending.get(message.id);
                    if (!entry) return;
                    this.pending.delete(message.id);
                    if (message.error) entry.reject(new Error(message.error.message ?? 'CDP error'));
                    else entry.resolve(message.result);
                    return;
                }
                for (const handler of this.handlers) handler(message);
            };
            socket.onclose = () => {
                this.closed = true;
                // Reject outstanding requests: navigating to a PDF makes Chrome
                // replace the target, and a silent close otherwise waits forever.
                for (const entry of this.pending.values()) entry.reject(new Error('CDP socket closed'));
                this.pending.clear();
            };
        });
        return this;
    }

    send(method, params = {}) {
        if (this.closed) return Promise.reject(new Error('CDP socket closed'));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    on(handler) {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    close() {
        try {
            this.socket?.close();
        }
        catch {
            // already gone
        }
        this.closed = true;
    }
}

let pageTargetId;

/** The tab CDP drives: the existing one when possible, else a new one. */
export async function pageTarget(port) {
    const targets = await endpoint(port, '/json/list');
    const pages = Array.isArray(targets) ? targets.filter((target) => target.type === 'page') : [];
    // A tab that is already showing a PDF has no usable JS context and its socket
    // dies on navigation, so prefer an ordinary page and open one when none is left.
    const isPdfTab = (url) => /\.pdf(\?|#|$)|article-pdf/i.test(url ?? '');
    const cached = pages.find((target) => target.id === pageTargetId);
    const existing = (cached && !isPdfTab(cached.url) ? cached : undefined)
        ?? pages.find((target) => !isPdfTab(target.url));
    if (existing) {
        pageTargetId = existing.id;
        return existing;
    }
    const created = await endpoint(port, '/json/new?about:blank');
    pageTargetId = created.id;
    return created;
}

/**
 * Interception patterns. A single broad pattern is used because a narrow one was
 * observed to miss the document response after a PDF navigation, while `*` is
 * proven to deliver it; only the PDF-shaped response is ever consumed.
 */
function patternsFor() {
    return [{ urlPattern: '*', requestStage: 'Response' }];
}

/**
 * The publisher's article page that must be loaded before its PDF endpoint
 * answers. Cloudflare and Atypon hand out the clearance cookie on that page,
 * and a PDF request without that warm-up is refused.
 * @param pdfUrl - a derived PDF URL.
 * @returns the landing URL to visit first, when one can be derived.
 */
export function warmupFor(pdfUrl) {
    try {
        const url = new URL(pdfUrl);
        const host = url.hostname;
        const pii = url.pathname.match(/\/pii\/([A-Za-z0-9()]+)/)?.[1];
        if (host.includes('sciencedirect') && pii) {
            return `https://www.sciencedirect.com/science/article/pii/${pii}`;
        }
        const arnumber = url.search.match(/arnumber=(\d+)/)?.[1];
        if (host.includes('ieeexplore') && arnumber) {
            return `https://ieeexplore.ieee.org/document/${arnumber}`;
        }
        const pdfDoi = url.pathname.match(/\/doi\/(?:pdf|pdfdirect|epdf|abs)\/(.+)$/)?.[1];
        if (pdfDoi && (host.includes('acm.org') || host.includes('wiley.com') || host.includes('tandfonline') || host.includes('informs.org'))) {
            return `https://${host}/doi/${pdfDoi}`;
        }
        // Nature uses the DOI suffix as the article id, not the whole DOI.
        const natureMatch = host.includes('nature.com') && url.pathname.match(/\/articles\/(.+)\.pdf$/);
        if (natureMatch) return `https://www.nature.com/articles/${natureMatch[1]}`;
        // RSC: /en/content/articlepdf/<year>/<journal>/<suffix> → articlelanding
        const rscMatch = url.pathname.match(/\/en\/content\/articlepdf\/(\d{4})\/([a-z]+)\/([a-z0-9]+)$/i);
        if (rscMatch) return `https://pubs.rsc.org/en/content/articlelanding/${rscMatch[1]}/${rscMatch[2]}/${rscMatch[3]}`;
        return undefined;
    }
    catch {
        return undefined;
    }
}

/** Wait for the tab's load event, then a short settle for late scripts. */
async function waitForLoad(client, timeoutMs = 15_000) {
    await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            off();
            resolve();
        }, timeoutMs);
        const off = client.on((message) => {
            if (message.method !== 'Page.loadEventFired' || done) return;
            done = true;
            clearTimeout(timer);
            off();
            setTimeout(resolve, 1_500);
        });
    });
}

/**
 * Fetch the PDF from inside the loaded page. Same-origin requests carry the
 * page's cookies and Referer, which is exactly what a bot wall wants to see.
 * Returns undefined when the page cannot make the request (cross-origin).
 */
async function inPageFetch(client, url, timeoutMs) {
    const expression = `(async () => {
        try {
            const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
            const type = res.headers.get('content-type') || '';
            if (!res.ok) return { ok: false, status: res.status, type };
            const buffer = new Uint8Array(await res.arrayBuffer());
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < buffer.length; i += chunk) {
                binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
            }
            return { ok: true, status: res.status, type, b64: btoa(binary) };
        } catch (error) {
            return { ok: false, status: 0, type: '', error: String(error && error.message || error) };
        }
    })()`;
    const result = await Promise.race([
        client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('in-page fetch timeout')), timeoutMs)),
    ]);
    const value = result?.result?.value;
    if (!value || value.ok !== true || typeof value.b64 !== 'string') {
        return value ? { ok: false, status: value.status ?? 0, error: value.error ?? value.type } : undefined;
    }
    const bytes = Buffer.from(value.b64, 'base64');
    if (!looksLikePdf(bytes)) return { ok: false, status: value.status, error: `in-page fetch got ${value.type || 'a non-PDF'}` };
    return { ok: true, status: value.status, bytes, contentType: value.type || 'application/pdf' };
}

/**
 * A real pointer click at the element's centre, the way a person activates a
 * control. Publisher pages gate downloads on that gesture, and a synthetic
 * `element.click()` is not one.
 * @param client - CDP session.
 * @param selector - CSS selector for the control.
 * @returns whether an element was found and clicked.
 */
async function clickSelector(client, selector) {
    const box = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`,
        returnByValue: true,
    });
    const point = box?.result?.value;
    if (!point) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', {
            type,
            x: Math.round(point.x),
            y: Math.round(point.y),
            button: 'left',
            clickCount: 1,
        }).catch(() => undefined);
    }
    return true;
}

/**
 * Load a URL in the user's Chrome and return its PDF bytes.
 *
 * Two routes, because publishers differ:
 * 1. warm the article page, click the publisher's own PDF control (a real
 *    pointer gesture), then fetch from inside the page — same origin, cookies
 *    and Referer intact;
 * 2. navigate straight to the PDF and capture the response in the Fetch domain,
 *    since Chrome's PDF viewer hides the body from `Network.getResponseBody`.
 * @param url - the PDF URL.
 * @param options - port, warm-up URL, timeouts, cancellation.
 */
export async function fetchViaBrowser(url, options = {}) {
    const { port, timeoutMs = 90_000, signal, warmupUrl } = options;
    const client = await openFreshTab(port);
    try {
        await client.send('Page.enable', {});

        if (warmupUrl) {
            await client.send('Page.navigate', { url: warmupUrl }).catch(() => undefined);
            await waitForLoad(client);
            // Prefer the publisher's own control: it is the path a reader takes,
            // and the request it produces carries the page's own context.
            await clickSelector(client, 'a[href*="pdfft"], a[href*="/doi/pdf"], a[href*="/stampPDF"]');
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            const warm = await inPageFetch(client, url, Math.min(timeoutMs, 60_000));
            if (warm?.ok) return { ...warm, finalUrl: url };
            if (signal?.aborted) throw new Error('aborted');
        }
        else {
            // No warm-up page: go straight to the navigation + interception path.
            // An in-page probe first was observed to leave the fresh tab in a state
            // where the document response never reached the Fetch domain.
        }

        await client.send('Fetch.enable', { patterns: patternsFor() });
        const captured = await new Promise((resolve, reject) => {
            let settled = false;
            let graceTimer;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`browser fetch timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error('aborted'));
            };
            const cleanup = () => {
                clearTimeout(timer);
                clearTimeout(graceTimer);
                signal?.removeEventListener('abort', onAbort);
                off();
            };
            const off = client.on(async (message) => {
                // A challenge page ("/craft/challenge/...") finishes loading long
                // before it redirects to the PDF, so keep listening instead of
                // giving up the moment the document settles.
                if (message.method === 'Page.loadEventFired' && !settled) {
                    clearTimeout(graceTimer);
                    graceTimer = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        reject(new Error('the page loaded but produced no PDF response (it may be a bot challenge; open the browser window and solve it, then retry)'));
                    }, 25_000);
                    return;
                }
                if (message.method !== 'Fetch.requestPaused') return;
                const { requestId, request, responseStatusCode, responseHeaders } = message.params;
                const contentType = (responseHeaders ?? [])
                    .find((header) => (header.name ?? '').toLowerCase() === 'content-type')?.value ?? '';
                try {
                    const looksPdf = /pdf/i.test(contentType) || /\.pdf(\?|#|$)/i.test(request.url ?? '');
                    if (!settled && looksPdf) {
                        settled = true;
                        const body = await client.send('Fetch.getResponseBody', { requestId });
                        cleanup();
                        resolve({ status: responseStatusCode ?? 0, url: request.url ?? url, contentType, base64: body.base64Encoded, data: body.body });
                    }
                }
                catch (error) {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        reject(error);
                    }
                }
                finally {
                    client.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
                }
            });
            client.send('Page.navigate', { url }).catch((error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            });
        });
        const bytes = captured.base64 ? Buffer.from(captured.data, 'base64') : Buffer.from(captured.data, 'utf8');
        if (!looksLikePdf(bytes)) {
            return {
                ok: false,
                status: captured.status,
                error: `the browser got ${captured.contentType || 'a non-PDF'} (HTTP ${captured.status}); probably a landing, login or challenge page`,
                contentType: captured.contentType,
            };
        }
        return { ok: true, status: captured.status, bytes, finalUrl: captured.url, contentType: captured.contentType || 'application/pdf' };
    }
    finally {
        // The tab is reused: the next download keeps the same session and cookies.
        client.close();
    }
}

/**
 * Open a CDP client on a fresh tab. Capture needs a clean document: a tab that
 * already showed a PDF, or one left in a viewer/broken state, closes its socket
 * as soon as it is navigated.
 * @param port - CDP port.
 * @returns the client, tagged with the tab id so the caller can close it.
 */
async function openFreshTab(port) {
    const created = await endpoint(port, '/json/new?about:blank');
    pageTargetId = created.id;
    const client = await new Cdp(created.webSocketDebuggerUrl).open();
    client.targetId = created.id;
    return client;
}

/** Close a tab opened by {@link openFreshTab}. */
async function closeTab(port, targetId) {
    if (!targetId) return;
    try {
        await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
    }
    catch {
        // tab already gone
    }
}

/**
 * Make Chrome download PDFs instead of handing them to its viewer.
 *
 * The viewer keeps the bytes out of every CDP capture path; once this preference
 * is set, a navigation to a publisher PDF simply writes a file, which is both
 * faster and immune to target replacement.
 * @param userDataDir - the plugin's own Chrome profile directory.
 */
export async function ensurePdfDownloadPref(userDataDir) {
    const dir = join(userDataDir, 'Default');
    const file = join(dir, 'Preferences');
    try {
        await mkdir(dir, { recursive: true });
        let preferences = {};
        try {
            preferences = JSON.parse(await readFile(file, 'utf8'));
        }
        catch {
            preferences = {};
        }
        preferences.plugins ??= {};
        if (preferences.plugins.always_open_pdf_externally === true) return true;
        preferences.plugins.always_open_pdf_externally = true;
        await writeFile(file, JSON.stringify(preferences), 'utf8');
        return true;
    }
    catch {
        return false;
    }
}

/**
 * Navigate the browser to a URL and let Chrome save the file it receives.
 * @param url - a URL that answers with a PDF.
 * @param options - port, download directory, timeout, cancellation.
 */
export async function downloadViaChromeFile(url, options = {}) {
    const { port, dir, timeoutMs = 90_000, signal } = options;
    await mkdir(dir, { recursive: true });
    const client = await openFreshTab(port);
    try {
        await client.send('Page.enable', {});
        await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true })
            .catch(() => client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }).catch(() => undefined));
        const before = new Set(await readdir(dir));
        await client.send('Page.navigate', { url }).catch((error) => {
            if (!/closed/i.test(String(error?.message))) throw error;
        });
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (signal?.aborted) return { ok: false, error: 'aborted' };
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            const fresh = (await readdir(dir)).filter((name) => !before.has(name) && !name.endsWith('.crdownload'));
            for (const name of fresh) {
                const path = join(dir, name);
                const first = (await stat(path)).size;
                await new Promise((resolve) => setTimeout(resolve, 1_200));
                const second = (await stat(path)).size;
                if (first === second && second > 10_000) {
                    const bytes = await readFile(path);
                    if (!looksLikePdf(bytes)) continue;
                    await unlink(path).catch(() => undefined);
                    return { ok: true, bytes, finalUrl: url, contentType: 'application/pdf' };
                }
            }
        }
        return { ok: false, error: `the browser produced no file within ${timeoutMs} ms` };
    }
    finally {
        client.close();
    }
}

/**
 * Open a page in the plugin's own Chrome, in front, so the person can sign in.
 *
 * The profile is persistent (`userDataDir`), so a session established here is
 * reused by every later download without asking again.
 * @param options - port, profile directory, optional URL, Chrome binary.
 */
export async function openForLogin(options = {}) {
    const { url, ...browserSettings } = options;
    await ensureBrowser({ ...browserSettings, timeoutMs: 30_000 });
    const client = await openFreshTab(browserSettings.port);
    try {
        await client.send('Page.enable', {});
        if (typeof url === 'string' && url.length > 0) {
            await client.send('Page.navigate', { url });
        }
        // Chromium refuses activation unless the window is already visible; the
        // spawn above made it visible, so this only raises it.
        await client.send('Page.bringToFront').catch(() => undefined);
        return { ok: true, targetId: client.targetId };
    }
    finally {
        // Leave the tab open: the person needs it. Closing only the socket keeps
        // the page alive for signing in.
        client.close();
    }
}

/**
 * Which sites currently hold a session in the plugin's Chrome.
 *
 * Only names and counts are returned — never cookie values.
 * @param port - CDP port.
 * @param hosts - publisher hosts to report on.
 */
export async function sessionStatus(port, hosts = []) {
    const client = await openFreshTab(port);
    try {
        await client.send('Network.enable', {});
        const result = await client.send('Network.getAllCookies', {});
        const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
        const byDomain = new Map();
        for (const cookie of cookies) {
            const domain = String(cookie.domain ?? '').replace(/^\./, '');
            if (!domain) continue;
            const entry = byDomain.get(domain) ?? { domain, count: 0, session: false };
            entry.count += 1;
            if (cookie.session) entry.session = true;
            byDomain.set(domain, entry);
        }
        const known = hosts.map((host) => {
            const hit = [...byDomain.values()].find((entry) => host.endsWith(entry.domain) || entry.domain.endsWith(host));
            return { host, signedIn: Boolean(hit), cookies: hit?.count ?? 0 };
        });
        return { total: cookies.length, domains: byDomain.size, known };
    }
    finally {
        client.close();
    }
}

/** Default matcher for a publisher's authorised PDF asset link. */
export const ASSET_URL = /pdf\.sciencedirectassets\.com|X-Amz-Signature|\/main\.pdf/i;

/**
 * Watch the browser for the authorised asset link a reader gets after passing a
 * challenge and clicking the publisher's PDF control. That link is a signed,
 * time-limited URL, and fetching it needs no browser and no challenge: the
 * person performs the only step that requires a person.
 * @param options - port, matcher, window, cancellation.
 */
export async function harvestAssetUrl(options = {}) {
    const { port, predicate = (url) => ASSET_URL.test(url), timeoutMs = 60_000, intervalMs = 700, signal } = options;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal?.aborted) return undefined;
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const hit = (Array.isArray(list) ? list : []).find((target) => target.type === 'page' && predicate(target.url ?? ''));
            if (hit) return { url: hit.url, id: hit.id };
        }
        catch {
            // browser may be restarting; keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return undefined;
}

/**
 * Follow one repository landing page and return the PDF links it offers.
 *
 * Unpaywall often reports a handle rather than a file (`hdl.handle.net/…`), and
 * those repositories answer a plain HTTP client with 418/403. A browser sees the
 * same page a reader would, so the bitstream link can be read from it.
 * @param url - landing page URL.
 * @param options - port, timeout, cancellation.
 */
export async function extractPdfLinks(url, options = {}) {
    const { port, timeoutMs = 45_000, signal } = options;
    const client = await openFreshTab(port);
    try {
        await client.send('Page.enable', {});
        await client.send('Page.navigate', { url });
        await waitForLoad(client, Math.min(timeoutMs, 30_000));
        if (signal?.aborted) return [];
        const result = await client.send('Runtime.evaluate', {
            expression: `[...document.querySelectorAll('a')]
                .map((a) => a.href)
                .filter((h) => /bitstream|\\/download|server\\/api|\\/pdf\\b|\\.pdf$/i.test(h))
                .slice(0, 5)`,
            returnByValue: true,
        });
        return (result?.result?.value ?? []).filter((link) => typeof link === 'string' && link.startsWith('http'));
    }
    catch {
        return [];
    }
    finally {
        client.close();
    }
}

/** True when a page is currently showing a bot challenge for this tab. */export async function pageShowsChallenge(port) {
    try {
        const target = await pageTarget(port);
        const client = await new Cdp(target.webSocketDebuggerUrl).open(5_000);
        try {
            const probe = await client.send('Runtime.evaluate', {
                expression: `(() => {
                    const html = document.documentElement?.innerHTML ?? '';
                    const frames = [...document.querySelectorAll('iframe')].map(f => f.src || '');
                    return {
                        url: location.href,
                        title: document.title || '',
                        challenge: /turnstile|recaptcha|challenge-platform|cf-chl|verify you are human|are you a robot/i.test(html + ' ' + frames.join(' ')),
                    };
                })()`,
                returnByValue: true,
            });
            return probe?.result?.value ?? { challenge: false };
        }
        finally {
            client.close();
        }
    }
    catch {
        return { challenge: false };
    }
}



