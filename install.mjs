#!/usr/bin/env node
/**
 * One-command installer for the dsh-literature plugin.
 *
 * Steps: unpack the tarball, install its dependencies, then register it in a DSH
 * profile (a `link:` dependency plus an entry in `dsh.profile.bundles`). Both
 * halves matter: the loader only mounts bundles that are listed, so installing
 * alone would leave the plugin invisible.
 *
 * Usage:
 *   node install.mjs [--profile web] [--dir <where to unpack>] [--home <DSH_HOME>]
 *
 * Safe to re-run: an existing directory is reused and updated in place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Parse `--key value` pairs; anything unknown is reported rather than ignored. */
function parseArgs(argv) {
    const options = { profile: 'web', dir: '', home: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--profile') options.profile = argv[++index];
        else if (arg === '--dir') options.dir = argv[++index];
        else if (arg === '--home') options.home = argv[++index];
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

/** The DSH data directory: explicit flag, then env, then the default location. */
function resolveHome(explicit) {
    if (explicit) return resolve(explicit);
    if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME);
    return join(homedir(), '.dsh');
}

/** Locate the tarball that sits beside this script. */
function findTarball() {
    const candidates = readdirSync(here).filter((name) => name.endsWith('.tgz'));
    if (candidates.length === 0) throw new Error('no .tgz found next to install.mjs');
    // Pick the newest, so a re-downloaded package wins over a stale copy.
    return candidates
        .map((name) => ({ name, time: statSync(join(here, name)).mtimeMs }))
        .sort((left, right) => right.time - left.time)[0].name;
}

function run(command, args, cwd) {
    execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

/**
 * Unpack a .tgz using the platform's tar.
 *
 * Windows 10+ ships bsdtar, macOS ships bsdtar too, and every Linux DPkg or RPM
 * system has GNU tar; Node has no built-in extractor, so this is the portable path.
 */
function unpack(tarball, destination) {
    mkdirSync(destination, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1'], here);
}

/** Register the plugin in a profile so the loader will mount it. */
function register(home, profile, pluginDir) {
    const profileDir = join(home, 'profiles', profile);
    const packageFile = join(profileDir, 'package.json');
    mkdirSync(profileDir, { recursive: true });

    let manifest;
    try {
        manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
    }
    catch {
        manifest = {};
    }
    manifest.name ??= `dsh-profile-${profile}`;
    manifest.private = true;
    manifest.dsh ??= {};
    manifest.dsh.profile ??= {};
    const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
    const added = !bundles.includes('dsh-literature');
    if (added) bundles.push('dsh-literature');
    manifest.dsh.profile.bundles = bundles;

    manifest.dependencies ??= {};
    // A link keeps this directory as the single source of truth, so edits here are
    // picked up on restart without reinstalling.
    const wanted = `link:${pluginDir.split('\\').join('/')}`;
    const changedDependency = manifest.dependencies['dsh-literature'] !== wanted;
    manifest.dependencies['dsh-literature'] = wanted;

    writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { profileDir, packageFile, added, changedDependency };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log('node install.mjs [--profile web] [--dir <dir>] [--home <DSH_HOME>]');
        return;
    }
    const home = resolveHome(options.home);
    const pluginDir = resolve(options.dir || join(home, 'plugins', 'dsh-literature'));
    const tarball = findTarball();

    console.log(`DSH_HOME   ${home}`);
    console.log(`profile    ${options.profile}`);
    console.log(`插件目录   ${pluginDir}`);
    console.log(`包         ${tarball}`);
    console.log('');

    console.log('① 解包…');
    unpack(join(here, tarball), pluginDir);

    console.log('② 安装依赖…');
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], pluginDir);

    console.log('③ 登记到 profile…');
    const result = register(home, options.profile, pluginDir);

    console.log('④ 自检…');
    // ESM only accepts file:// URLs, so an absolute Windows path must be converted.
    const moduleUrl = pathToFileURL(join(pluginDir, 'lib', 'index.js')).href;
    const tools = execFileSync(process.execPath, ['-e', `
        import(${JSON.stringify(moduleUrl)}).then((module) => {
            const names = [];
            module.apply({ tools: { register: (tool) => names.push(tool.name) }, systemPrompt: { section() {} }, get: () => undefined }, module.Config({}));
            console.log(names.length + ' ' + names.join(','));
        }).catch((error) => { console.error('LOAD_FAIL ' + error.message); process.exit(1); });
    `], { encoding: 'utf8', cwd: pluginDir }).trim();
    if (!/^\d+ /.test(tools)) throw new Error(`plugin did not load: ${tools}`);
    const [count] = tools.split(' ');
    console.log(`     ${count} 个工具注册成功`);

    console.log('');
    console.log('完成。下一步：');
    console.log(`  1. 在 ${join(home, 'profiles', options.profile, 'cordis.patch.yml')} 里填两个邮箱：`);
    console.log('       - id: literature');
    console.log('         name: dsh-literature');
    console.log('         config:');
    console.log('           openalexMailto: 你的邮箱');
    console.log('           unpaywallEmail: 你的邮箱');
    console.log('  2. 重启 DSH');
    console.log('  3. 对助手说一句「跑一下文献插件自检」');
    if (result.added) console.log('');
    if (result.added === false) console.log('（该 profile 之前已登记过，本次只更新了路径）');
}

try {
    main();
}
catch (error) {
    console.error(`安装失败：${error.message}`);
    process.exit(1);
}
