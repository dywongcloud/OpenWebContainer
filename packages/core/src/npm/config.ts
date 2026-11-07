import { IFileSystem } from '../filesystem';
import { joinPaths } from '../process/executors/node/runtime/resolver';
import { findPackageRoot } from './scripts';

/**
 * `npm config`: the command that reads npm's own settings rather than a package. `get` answers with
 * the value of what it was asked for, `list` with the whole of it, and `set` writes a project
 * `.npmrc` -- the file npm's own `config set` writes when it is given no `--location`.
 *
 * The values are npm's own defaults, overlaid the way npm overlays them: a project `.npmrc` next,
 * then the user's, then `npm_config_<key>` in the environment, which is the one that wins.
 */

export interface ConfigResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * The layout npm's global mode uses under the configured prefix. A host keeps globally installed
 * packages at <prefix>/lib/node_modules and links their bins into <prefix>/bin; `npm ls -g` is
 * rooted at <prefix>/lib, and npm's own global config file is <prefix>/etc/npmrc.
 */
export interface GlobalPaths {
    prefix: string;
    /** The directory `npm ls -g` draws its tree from. */
    lib: string;
    /** The global package tree. */
    modules: string;
    /** The directory global bin links are written into. */
    bin: string;
    /** npm_config_globalconfig. */
    globalconfig: string;
}

/** The configured prefix: npm's own default is /usr/local, overridable by .npmrc or npm_config_prefix. */
export function resolveGlobalPrefix(fileSystem: IFileSystem, cwd: string, env: Record<string, string>): string {
    const config = resolveConfig(fileSystem, cwd, env);
    return config.prefix || DEFAULTS.prefix;
}

/** Every directory a global command needs, derived from the configured prefix. */
export function globalPaths(fileSystem: IFileSystem, cwd: string, env: Record<string, string>): GlobalPaths {
    const prefix = resolveGlobalPrefix(fileSystem, cwd, env);
    return {
        prefix,
        lib: joinPaths(prefix, 'lib'),
        modules: joinPaths(prefix, 'lib/node_modules'),
        bin: joinPaths(prefix, 'bin'),
        globalconfig: joinPaths(prefix, 'etc/npmrc')
    };
}

/** `-g`, `--global` and `--location=global` all put npm in global mode. */
export function isGlobalArg(args: string[]): boolean {
    return args.some((arg) => arg === '-g' || arg === '--global' || arg === '--location=global');
}

/** `npm config get <key>`: globalconfig and global_prefix are derived from the prefix, not static. */
function configValue(config: Record<string, string>, key: string): string {
    if (key === 'globalconfig') return joinPaths(config.prefix || DEFAULTS.prefix, 'etc/npmrc');
    if (key === 'global_prefix' || key === 'global-prefix') return config.prefix || DEFAULTS.prefix;
    return config[key] ?? 'undefined';
}

/** npm's own defaults for the keys this runtime answers. */
const DEFAULTS: Record<string, string> = {
    registry: 'https://registry.npmjs.org/',
    cache: '~/.npm',
    prefix: '/usr/local',
    tag: 'latest',
    'init-version': '1.0.0',
    'init-license': 'ISC',
    'save-prefix': '^',
    fund: 'true',
    audit: 'true',
    progress: 'true',
    depth: '0'
};

/** The `~` in npm's own `cache` default is the home directory, which is what npm expands it to. */
function homeDirectory(env: Record<string, string>): string {
    return env.HOME ?? '/home';
}

/** Where the user's own `.npmrc` sits: npm's `userconfig`, `<home>/.npmrc`. */
function userNpmrc(env: Record<string, string>): string {
    return joinPaths(homeDirectory(env), '.npmrc');
}

/** `key = value` lines, `;` and `#` comments: the shape of an npmrc, which is an ini file. */
function parseNpmrc(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
        const equals = line.indexOf('=');
        if (equals <= 0) continue;
        const key = line.slice(0, equals).trim();
        const value = line.slice(equals + 1).trim();
        /* npm strips one layer of quotes around a value, and keeps an empty one as the empty string. */
        out[key] = value.replace(/^(["'])(.*)\1$/, '$2');
    }
    return out;
}

/** The whole config: npm's defaults, then the project's npmrc, then the user's, then the environment. */
export function resolveConfig(
    fileSystem: IFileSystem,
    cwd: string,
    env: Record<string, string>
): Record<string, string> {
    const config: Record<string, string> = { ...DEFAULTS };
    const packageDir = findPackageRoot(fileSystem, cwd);
    const files = [
        packageDir === undefined ? undefined : joinPaths(packageDir, '.npmrc'),
        userNpmrc(env)
    ];
    for (const file of files) {
        if (file === undefined) continue;
        if (fileSystem.statPath(file)?.type !== 'file') continue;
        Object.assign(config, parseNpmrc(fileSystem.readFile(file) ?? ''));
    }
    for (const [name, value] of Object.entries(env)) {
        if (!name.startsWith('npm_config_')) continue;
        /* `npm_config_` names the key with its dashes underscored: `npm_config_init_version`. */
        config[name.slice('npm_config_'.length).replace(/_/g, '-')] = value;
    }
    return expandHome(config, homeDirectory(env));
}

/** `~` at the front of a value is the home directory, wherever npm wrote one. */
function expandHome(config: Record<string, string>, home: string): Record<string, string> {
    for (const [key, value] of Object.entries(config)) {
        if (value === '~') config[key] = home;
        else if (value.startsWith('~/')) config[key] = joinPaths(home, value.slice(2));
    }
    return config;
}

/** The keys npm was asked for: every bare word of the line, a flag never being one. */
function requestedKeys(args: string[]): string[] {
    return args.filter((arg) => !arg.startsWith('-'));
}

/**
 * `npm config get [<key>...]`: one key answers with its value alone, several answer with
 * `key=value` lines, and a key npm has no value for answers `undefined`, which is the string npm
 * prints for it. No key at all is `npm config get` of everything, and answers with the listing.
 */
export function runConfigGet(config: Record<string, string>, args: string[]): ConfigResult {
    const keys = requestedKeys(args);
    if (keys.length === 0) return { stdout: configListing(config), stderr: '', exitCode: 0 };
    if (keys.length === 1) return { stdout: `${configValue(config, keys[0])}\n`, stderr: '', exitCode: 0 };
    const lines = keys.map((key) => `${key}=${configValue(config, key)}`);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

/**
 * `npm config list`: npm's own listing of the config it is running under -- one `key = value` line
 * per setting, with the file a setting came from above the ones it carries, and the rest of what npm
 * knows about itself as comments behind it.
 */
function configListing(config: Record<string, string>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(config).sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(`${key} = ${value}`);
    }
    return lines.join('\n') + '\n';
}

/** npm's own config keys: `npm config set` refuses a name npm has no option for. */
const KNOWN_CONFIG_KEYS = new Set(`_auth access all allow-git allow-same-version also audit audit-level auth-type before bin-links browser bypass-2fa ca cache cache-max cache-min cafile call cert cidr color commit-hooks cpu depth description dev diff diff-dst-prefix diff-ignore-all-space diff-name-only diff-no-prefix diff-src-prefix diff-text diff-unified dry-run editor engine-strict expect-result-count expect-results expires fetch-retries fetch-retry-factor fetch-retry-maxtimeout fetch-retry-mintimeout fetch-timeout force foreground-scripts format-package-lock fund git git-tag-version global global-style globalconfig heading https-proxy if-present ignore-scripts include include-attestations include-staged include-workspace-root init-author-email init-author-name init-author-url init-license init-module init-private init-type init-version init.author.email init.author.name init.author.url init.license init.module init.version install-links install-strategy json key legacy-bundling legacy-peer-deps libc link local-address location lockfile-version loglevel logs-dir logs-max long maxsockets message min-release-age name node-gyp node-options noproxy offline omit omit-lockfile-registry-resolved only optional orgs orgs-permission os otp pack-destination package package-lock package-lock-only packages packages-all packages-and-scopes-permission parseable password prefer-dedupe prefer-offline prefer-online prefix preid production progress provenance provenance-file proxy read-only rebuild-bundle registry replace-registry-host save save-bundle save-dev save-exact save-optional save-peer save-prefix save-prod sbom-format sbom-type scope scopes script-shell searchexclude searchlimit searchopts searchstaleness shell shrinkwrap sign-git-commit sign-git-tag strict-peer-deps strict-ssl tag tag-version-prefix timing token-description umask unicode update-notifier usage user-agent userconfig version versions viewer which workspace workspaces workspaces-update yes`.split(' '));

/** `npm config set <key>=<value>`: the project `.npmrc`, which is where npm writes it. */
export function runConfigSet(
    fileSystem: IFileSystem,
    cwd: string,
    args: string[]
): ConfigResult {
    const assignments = args.filter((arg) => !arg.startsWith('-'));
    if (assignments.length === 0) {
        return { stdout: '', stderr: 'npm error code EUSAGE\nnpm error Usage: npm config set <key>=<value>\n', exitCode: 1 };
    }
    /* npm accepts both `key=value` and `key value`, and refuses a key it has no option for. */
    const pairs: { key: string; value: string }[] = [];
    for (let i = 0; i < assignments.length; i++) {
        const assignment = assignments[i];
        const equals = assignment.indexOf('=');
        if (equals > 0) {
            pairs.push({ key: assignment.slice(0, equals).trim(), value: assignment.slice(equals + 1).trim() });
        } else if (i + 1 < assignments.length) {
            pairs.push({ key: assignment, value: assignments[++i] });
        }
    }
    for (const { key } of pairs) {
        if (!KNOWN_CONFIG_KEYS.has(key) && DEFAULTS[key] === undefined) {
            return { stdout: '', stderr: `npm error \`${key}\` is not a valid npm option\n`, exitCode: 1 };
        }
    }
    const dir = findPackageRoot(fileSystem, cwd) ?? cwd;
    const file = joinPaths(dir, '.npmrc');
    const existing = fileSystem.statPath(file)?.type === 'file' ? parseNpmrc(fileSystem.readFile(file) ?? '') : {};
    for (const { key, value } of pairs) existing[key] = value;
    const text = Object.entries(existing).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
    fileSystem.writeFile(file, text);
    return { stdout: '', stderr: '', exitCode: 0 };
}

/** `npm config <sub> [...]`: `get`, `set` and `list`, and a usage error for anything else. */
export function runConfigCommand(
    fileSystem: IFileSystem,
    cwd: string,
    env: Record<string, string>,
    args: string[]
): ConfigResult {
    const [sub, ...rest] = args;
    const config = resolveConfig(fileSystem, cwd, env);
    switch (sub) {
        case 'get':
            return runConfigGet(config, rest);
        case 'set':
            return runConfigSet(fileSystem, cwd, rest);
        case 'list':
        case 'ls':
            return { stdout: configListing(config), stderr: '', exitCode: 0 };
        case undefined:
            return { stdout: configListing(config), stderr: '', exitCode: 0 };
        default:
            return {
                stdout: '',
                stderr: `npm error Unknown command: "${sub}"\n\nTo see a list of supported npm commands, run:\n  npm help\n`,
                exitCode: 1
            };
    }
}
