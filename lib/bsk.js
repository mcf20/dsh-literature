/**
 * browser-skill fallback.
 *
 * The plugin's own CDP channel is fast but it only knows the plugin's dedicated
 * Chrome profile. Some publishers answer only a reader who is signed in, and for
 * those the `bsk` CLI can drive the user's real browser. It is a slower route, so
 * it is used only after the fast one fails.
 *
 * `bsk download` captures a download produced by a click, so the sequence is:
 * open the article page, read its accessibility snapshot for the "Download PDF"
 * link, click that link and collect the file.
 * @module dsh-literature/bsk
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Run one CLI call and return stdout. */
async function run(bskPath, args, options = {}) {
    const { timeoutMs = 60_000 } = options;
    const { stdout } = await execFileAsync(bskPath, args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        // Never let a status probe try to spawn a daemon: inside the harness the
        // sandbox forbids a detached child, and the error would mask the real state.
        env: { ...process.env, BSK_AUTO_START: '0' },
    });
    return stdout;
}

/** True when the CLI exists and its daemon answers. */
export async function bskReady(bskPath) {
    try {
        const out = await run(bskPath, ['status', '--json'], { timeoutMs: 15_000 });
        const status = JSON.parse(out);
        return Array.isArray(status?.browsers) && status.browsers.length > 0;
    }
    catch {
        return false;
    }
}

/**
 * Pick the control that starts a PDF download from an accessibility snapshot.
 * "Download PDF" is preferred; a bare "PDF" link is the fallback.
 * @param snapshot - `bsk snapshot` output.
 */
export function pickDownloadRef(snapshot) {
    const lines = String(snapshot ?? '').split('\n');
    let bare;
    for (const line of lines) {
        const match = line.match(/@e(\d+)\s+link\s+"([^"]*)"/);
        if (!match) continue;
        const label = match[2].trim().toLowerCase();
        if (/download (pdf|full)/.test(label)) return `@e${match[1]}`;
        if (!bare && /^(pdf|view pdf)$/.test(label)) bare = `@e${match[1]}`;
    }
    return bare;
}

/**
 * Fetch one PDF through the user's real browser via the bsk CLI.
 * @param options - cli path, the page to open, destination file, timeout.
 */
export async function downloadViaBsk(options) {
    const { bskPath, pageUrl, outFile, timeoutMs = 120_000 } = options;
    let sessionId;
    try {
        const started = await run(bskPath, ['session', 'start', '--json'], { timeoutMs: 45_000 });
        sessionId = JSON.parse(started)?.session_id;
        if (!sessionId) return { ok: false, error: 'bsk 没有返回 session_id' };

        await run(bskPath, ['navigate', pageUrl, '--session', sessionId, '--json'], { timeoutMs: 60_000 });
        // The page may still be settling; one retry is enough for a challenge to clear.
        let ref;
        for (let attempt = 0; attempt < 2 && !ref; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2_500 : 6_000));
            const snapshot = await run(bskPath, ['snapshot', '--session', sessionId], { timeoutMs: 45_000 });
            ref = pickDownloadRef(snapshot);
        }
        if (!ref) return { ok: false, error: '页面里没有 Download PDF 按钮（可能需要登录或没有权限）' };

        await run(bskPath, ['download', '--session', sessionId, '--ref', ref, '--out', outFile, '--json'], { timeoutMs });
        return { ok: true, file: outFile };
    }
    catch (error) {
        const message = error?.stderr?.toString?.()?.trim() || error?.message || String(error);
        return { ok: false, error: `bsk 失败：${message.slice(0, 200)}` };
    }
    finally {
        if (sessionId) {
            await run(bskPath, ['session', 'stop', sessionId], { timeoutMs: 20_000 }).catch(() => undefined);
        }
    }
}
