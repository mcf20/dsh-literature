/**
 * HTTP primitives shared by every source adapter and the full-text chain.
 * Node's global fetch plus per-attempt timeouts, retries, and proxy routing:
 * many academic hosts are unreachable without the system proxy, and Node's
 * fetch ignores it, so undici's ProxyAgent is used when one is configured or
 * discovered.
 * @module dsh-literature/net
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const execFileAsync = promisify(execFile);

/** A browser-like UA for publisher and PDF hosts that reject robot agents. */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Publisher domains reached through an institutional subscription. Requests to
 * these hosts are routed through `institutionalProxyUrl` when one is set, so a
 * campus VPN/EZproxy egress is used for entitled content only.
 */
export const PUBLISHER_HOSTS = [
    'doi.org', 'sciencedirect.com', 'elsevier.com', 'springer.com', 'nature.com',
    'wiley.com', 'tandfonline.com', 'sagepub.com', 'acs.org', 'ieee.org',
    'aip.org', 'aps.org', 'academic.oup.com', 'cambridge.org', 'jstor.org',
    'bmj.com', 'thelancet.com', 'nejm.org', 'science.org', 'pnas.org',
    'cell.com', 'jbc.org', 'rupress.org', 'biologists.com', 'iopscience.iop.org',
    'acm.org', 'degruyter.com', 'karger.com', 'thieme-connect.com', 'spiedigitallibrary.org',
    'rsc.org', 'royalsocietypublishing.org', 'annualreviews.org', 'sciencemag.org',
];

/** True when the URL belongs to a publisher that sells institutional access. */
export function isPublisherHost(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return PUBLISHER_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    }
    catch {
        return false;
    }
}

/** Wrap a target URL in an EZproxy login prefix. */
export function viaEzproxy(url, prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) return url;
    return prefix.endsWith('=') ? `${prefix}${encodeURIComponent(url)}` : `${prefix}${url}`;
}

/** Statuses worth another attempt. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const agents = new Map();
let detectedProxy;

function agentFor(proxyUrl) {
    if (!proxyUrl) return undefined;
    let agent = agents.get(proxyUrl);
    if (!agent) {
        agent = new ProxyAgent(proxyUrl);
        agents.set(proxyUrl, agent);
    }
    return agent;
}

/**
 * Discover a proxy: explicit config, then the usual environment variables,
 * then (on Windows) the per-user Internet Settings entry that PowerShell and
 * browsers honour.
 * @param configured - the `proxyUrl` config value, when set.
 */
export async function resolveProxy(configured) {
    if (typeof configured === 'string' && configured.trim().length > 0) {
        const value = configured.trim();
        // `direct` opts out of every proxy layer: the machine's own egress is
        // already the institutional one when the user sits on campus.
        return value.toLowerCase() === 'direct' ? '' : value;
    }
    if (detectedProxy !== undefined) return detectedProxy;
    const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
    if (fromEnv) {
        detectedProxy = fromEnv;
        return detectedProxy;
    }
    if (process.platform === 'win32') {
        try {
            const { stdout } = await execFileAsync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { timeout: 2000 });
            const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(stdout);
            const server = stdout.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
            if (enabled && server) {
                const pick = server.includes('=')
                    ? (server.split(';').find((part) => part.startsWith('https=')) ?? server.split(';')[0]).split('=')[1]
                    : server;
                if (pick) {
                    detectedProxy = `http://${pick}`;
                    return detectedProxy;
                }
            }
        }
        catch {
            // No readable system proxy.
        }
    }
    detectedProxy = '';
    return '';
}

/**
 * A caller-visible User-Agent. OpenAlex, Crossref, Unpaywall and NCBI all ask
 * for an identifying UA, and OpenAlex/Crossref treat a contact address as the
 * polite-pool signal.
 * @param version - plugin version.
 * @param mailto - optional contact address appended for the polite pool.
 */
export function userAgent(version, mailto) {
    const base = `dsh-literature/${version} (DeepSeek Harness plugin)`;
    return mailto ? `${base} mailto:${mailto}` : base;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` is either delta-seconds or an HTTP date. */
function retryAfterMs(header) {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
    return undefined;
}

function combinedSignal(timeoutMs, outer) {
    const signals = [];
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    if (outer) signals.push(outer);
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
}

/**
 * One HTTP request with bounded retries.
 * @param url - absolute URL.
 * @param options - decoding (`as`), timeout, retry, headers, cancellation.
 * @returns a settled result; transport failures never throw.
 */
export async function request(url, options = {}) {
    const {
        as = 'json',
        timeoutMs = 30_000,
        retries = 3,
        backoffMs = 800,
        headers = {},
        signal,
        maxBytes = 96 * 1024 * 1024,
        ua,
        method = 'GET',
        body,
        proxy,
        institutionalProxy,
    } = options;
    const routed = institutionalProxy && isPublisherHost(url) ? institutionalProxy : proxy;
    const dispatcher = agentFor(await resolveProxy(routed));
    const attempts = Math.max(1, Math.floor(retries) || 1);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const res = await undiciFetch(url, {
                method,
                body,
                dispatcher,
                redirect: 'follow',
                signal: combinedSignal(timeoutMs, signal),
                headers: {
                    accept: 'application/json, text/xml;q=0.9, text/plain;q=0.8, */*;q=0.5',
                    ...(ua ? { 'user-agent': ua } : {}),
                    ...headers,
                },
            });
            const contentType = res.headers.get('content-type') ?? '';
            if (!res.ok) {
                const wait = retryAfterMs(res.headers.get('retry-after'));
                if (RETRYABLE.has(res.status) && attempt < attempts) {
                    await sleep(wait ?? backoffMs * 2 ** (attempt - 1));
                    continue;
                }
                return {
                    ok: false,
                    status: res.status,
                    error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
                    finalUrl: res.url,
                    contentType,
                };
            }
            if (as === 'bytes') {
                const announced = Number(res.headers.get('content-length') ?? '0');
                if (Number.isFinite(announced) && announced > maxBytes) {
                    return { ok: false, status: res.status, error: `response is ${announced} bytes, over the ${maxBytes}-byte limit`, finalUrl: res.url, contentType };
                }
                const data = Buffer.from(await res.arrayBuffer());
                if (data.byteLength > maxBytes) {
                    return { ok: false, status: res.status, error: `response is ${data.byteLength} bytes, over the ${maxBytes}-byte limit`, finalUrl: res.url, contentType };
                }
                return { ok: true, status: res.status, data, finalUrl: res.url, contentType };
            }
            const text = await res.text();
            if (as === 'text') {
                return { ok: true, status: res.status, data: text, finalUrl: res.url, contentType };
            }
            try {
                return { ok: true, status: res.status, data: JSON.parse(text), finalUrl: res.url, contentType };
            }
            catch {
                return { ok: false, status: res.status, error: 'response is not JSON', finalUrl: res.url, contentType };
            }
        }
        catch (error) {
            lastError = error;
            if (signal?.aborted) return { ok: false, status: 0, error: 'aborted' };
            if (attempt < attempts) {
                await sleep(backoffMs * 2 ** (attempt - 1));
                continue;
            }
        }
    }
    const reason = lastError?.message ?? 'request failed';
    return { ok: false, status: 0, error: reason };
}

/** True when the bytes start with the `%PDF` magic. */
export function looksLikePdf(data) {
    return data.length > 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
}

/** Trim, collapse whitespace, and drop zero-width noise from extracted text. */
export function tidy(value) {
    if (typeof value !== 'string') return undefined;
    const out = value.replace(/\u0000/g, '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    return out.length > 0 ? out : undefined;
}
