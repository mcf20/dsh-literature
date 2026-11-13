/**
 * Article-page route: open the publisher's own article page, click its PDF
 * control, and capture the response that follows. This mirrors what a reader
 * does in the browser, which is what bot walls (Elsevier's `/craft/challenge`)
 * are checking for; navigating straight at the PDF endpoint is refused.
 * @module dsh-literature/browser-click
 */
import { Cdp, pageTarget } from './browser.js';
import { looksLikePdf } from './net.js';

/** Links that a publisher uses for "View PDF". */
const PDF_LINK = /(pdfft|\/pdf\/|pdfdirect|epdf|\/fulltextpdf)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the document is at least interactive. */
async function settle(client, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const probe = await client.send('Runtime.evaluate', {
                expression: 'document.readyState',
                returnByValue: true,
            });
            if (probe?.result?.value === 'complete' || probe?.result?.value === 'interactive') {
                await sleep(1_200);
                return true;
            }
        }
        catch {
            // navigation in flight
        }
        await sleep(400);
    }
    return false;
}

/** Markers of a human-verification page. */
const CHALLENGE = /are you a robot|verify you are a human|complete the captcha|captcha challenge|cf-chl|challenge-platform|just a moment/i;

/**
 * Markers of a paywall the reader could pass by signing in, as opposed to a paper
 * the institution simply does not license.
 */
export const NEEDS_LOGIN = /access through your (institution|organization)|institutional (login|access|sign in)|sign in to (access|download|view)|log in to (access|download|view)|请登录|登录后(可)?(下载|查看)|机构登录|institution does not provide access/i;

/** Markers of a hard paywall: no sign-in will help. */
export const NO_ENTITLEMENT = /does not provide access to this content|you do not have access|purchase (this )?article|get access to the full (version|text)|buy article|rent this article/i;

/**
 * Read the article page and say why it produced no PDF.
 *
 * Three outcomes are distinguished because they need different actions: a hard
 * paywall (nothing to do), a sign-in invitation (the person logs in once), and an
 * unclassified failure.
 * @param client - an open CDP client on the article tab.
 * @returns a message plus `needsLogin` / `noEntitlement` flags, or undefined.
 */
async function explainPage(client) {
    const state = await client.send('Runtime.evaluate', {
        expression: `(() => ({
            url: location.href,
            text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 4000),
        }))()`,
        returnByValue: true,
    }).catch(() => undefined);
    const text = state?.result?.value?.text ?? '';
    if (text.length === 0) return undefined;
    if (CHALLENGE.test(text)) {
        return {
            message: '页面停在人机验证：在那个 Chrome 窗口里完成验证，然后让我重试',
            needsHuman: true,
        };
    }
    if (NO_ENTITLEMENT.test(text)) {
        return {
            message: '这个机构没有该刊的订阅权限（页面直接给了购买/租用选项），换渠道也拿不到',
            noEntitlement: true,
        };
    }
    if (NEEDS_LOGIN.test(text)) {
        return {
            message: '这篇需要登录机构账号：用 lit_login 打开那个窗口登录一次，之后下载会自动复用',
            needsLogin: true,
        };
    }
    return undefined;
}

/**
 * Poll the tab until the reader solves whatever challenge is on screen. The
 * plugin never answers the challenge itself; it only waits for the person.
 * @param options - port, how long to wait, cancellation.
 */
export async function waitForChallengeClearance(options = {}) {
    const { port, humanTimeoutMs = 180_000, signal } = options;
    const target = await pageTarget(port);
    const client = await new Cdp(target.webSocketDebuggerUrl).open();
    try {
        const deadline = Date.now() + humanTimeoutMs;
        while (Date.now() < deadline) {
            if (signal?.aborted) return { cleared: false, reason: 'aborted' };
            const probe = await client.send('Runtime.evaluate', {
                expression: `(() => {
                    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
                    const links = [...document.querySelectorAll('a')].filter((a) => ${PDF_LINK}.test(a.href || '')).length;
                    return { url: location.href, challenge: ${CHALLENGE}.test(text), links };
                })()`,
                returnByValue: true,
            }).catch(() => undefined);
            const value = probe?.result?.value;
            if (value && !value.challenge && value.links > 0) return { cleared: true, url: value.url };
            if (value && !value.challenge && /\.pdf(\?|#|$)/i.test(value.url)) return { cleared: true, url: value.url };
            await sleep(2_000);
        }
        return { cleared: false, reason: 'timeout' };
    }
    finally {
        client.close();
    }
}

/**
 * Open `articleUrl`, follow its PDF control, and return the PDF bytes.
 * @param options - port, article URL, timeout, cancellation.
 */
export async function fetchViaArticlePage(options = {}) {
    const { port, articleUrl, timeoutMs = 90_000, signal, humanTimeoutMs = 180_000 } = options;
    const target = await pageTarget(port);
    const client = await new Cdp(target.webSocketDebuggerUrl).open();
    const aborted = () => signal?.aborted === true;
    try {
        await client.send('Page.enable', {});
        await client.send('Network.enable', {}).catch(() => undefined);
        await client.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => undefined);

        await client.send('Page.navigate', { url: articleUrl });
        await settle(client);
        if (aborted()) throw new Error('aborted');

        // The challenge text and the PDF control both appear a moment after the
        // document reports complete, so poll until the page settles into one.
        const readState = async () => {
            const state = await client.send('Runtime.evaluate', {
                expression: `(() => {
                    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
                    const links = [...document.querySelectorAll('a, button')]
                        .map((el) => ({ el, href: el.href || '' }))
                        .filter((entry) => ${PDF_LINK}.test(entry.href) || /view pdf|download pdf/i.test(entry.el.textContent || ''));
                    return { challenge: ${CHALLENGE}.test(text), links: links.length, text: text.slice(0, 240) };
                })()`,
                returnByValue: true,
            }).catch(() => undefined);
            return state?.result?.value;
        };
        let snapshot;
        const stateDeadline = Date.now() + 15_000;
        while (Date.now() < stateDeadline) {
            snapshot = await readState();
            if (snapshot && (snapshot.challenge || snapshot.links > 0)) break;
            await sleep(1_000);
        }

        if (snapshot?.challenge) {
            // Hand the window to the reader; continue on our own once cleared.
            const cleared = await waitForChallengeClearance({ port, humanTimeoutMs, signal });
            if (!cleared.cleared) {
                return {
                    ok: false,
                    needsHuman: true,
                    error: `需要你在这个 Chrome 窗口里完成人机验证（${cleared.reason === 'timeout' ? '等待超时' : '已取消'}）；点完再让我重试即可`,
                };
            }
            await client.send('Page.navigate', { url: articleUrl });
            await settle(client);
        }

        await client.send('Fetch.enable', {
            patterns: [
                { urlPattern: '*pdf.sciencedirectassets.com/*', requestStage: 'Response' },
                { urlPattern: '*pdfft*', requestStage: 'Response' },
                { urlPattern: '*pdf*', requestStage: 'Response' },
            ],
        });

        let settleCapture;
        let failCapture;
        const captured = new Promise((resolve, reject) => {
            settleCapture = resolve;
            failCapture = reject;
        });
        // The timer may fire after we have already given up on this route.
        captured.catch(() => undefined);
        const stopListening = client.on(async (message) => {
            if (message.method !== 'Fetch.requestPaused') return;
            const { requestId, request, responseStatusCode, responseHeaders } = message.params;
            const contentType = (responseHeaders ?? [])
                .find((header) => (header.name ?? '').toLowerCase() === 'content-type')?.value ?? '';
            try {
                const isPdf = /pdf/i.test(contentType)
                    || /pdf\.sciencedirectassets\.com/i.test(request.url ?? '')
                    || /\.pdf(\?|#|$)/i.test(request.url ?? '');
                if (isPdf) {
                    const body = await client.send('Fetch.getResponseBody', { requestId });
                    const bytes = body.base64Encoded
                        ? Buffer.from(body.body, 'base64')
                        : Buffer.from(body.body, 'utf8');
                    if (looksLikePdf(bytes)) {
                        stopListening();
                        settleCapture({ ok: true, status: responseStatusCode ?? 0, bytes, finalUrl: request.url, contentType });
                        return;
                    }
                }
            }
            catch {
                // body already gone; try the next response
            }
            finally {
                client.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
            }
        });
        const captureTimer = setTimeout(async () => {
            stopListening();
            // Before reporting a bare timeout, read what the page says. A sign-in
            // invitation is recoverable (log in once, the profile keeps it); a hard
            // paywall is not, and the two must not be reported the same way.
            const detail = await explainPage(client);
            failCapture(detail
                ? Object.assign(new Error(detail.message), detail)
                : new Error('no PDF response after opening the article page'));
        }, timeoutMs);
        captureTimer.unref?.();

        // Click the page's own PDF control: a real gesture on the real page.
        const clicked = await Promise.race([
            client.send('Runtime.evaluate', {
            expression: `(() => {
                const links = [...document.querySelectorAll('a, button')]
                    .map((el) => ({ el, href: el.href || el.getAttribute('data-href') || '' }))
                    .filter((entry) => ${PDF_LINK}.test(entry.href) || /view pdf|download pdf/i.test(entry.el.textContent || ''));
                const first = links[0];
                if (!first) return { clicked: false, pageText: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) };
                first.el.scrollIntoView({ block: 'center' });
                first.el.click();
                return { clicked: true, href: first.href };
            })()`,
            returnByValue: true,
            }).catch(() => undefined),
            new Promise((resolve) => setTimeout(() => resolve(undefined), 10_000)),
        ]);

        const info = clicked?.result?.value;
        if (!info?.clicked) {
            throw new Error(`the article page offers no PDF control (${info?.pageText ?? 'no page text'})`);
        }

        const result = await captured;
        return result;
    }
    finally {
        client.close();
    }
}


