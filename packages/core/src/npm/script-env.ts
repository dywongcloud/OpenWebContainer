import { IFileSystem } from '../filesystem';
import { joinPaths } from '../process/executors/node/runtime/resolver';
import { NODE_BINARY } from '../process/executors/default-env';
import { NODE_VERSION } from '../process/executors/node/runtime/guest/globals';
import { CONTAINER_PLATFORM } from './platform';
import { NPM_VERSION } from './scripts';
import { resolveConfig } from './config';

/**
 * The environment a script npm runs sees, and the one it did not.
 *
 * npm's own run-script builds it in two places: `@npmcli/run-script`'s `make-spawn-args.js` puts
 * `npm_package_json`, `npm_lifecycle_event`, `npm_lifecycle_script` and `npm_config_node_gyp` beside
 * the process's own environment, and `@npmcli/config`'s `set-envs.js` has already put the
 * `npm_config_*` set, `npm_execpath` and `npm_node_execpath` into it, plus the `npm_package_*` fields
 * `package-envs.js` derives from the manifest. A script has always read these -- `npm_package_name`
 * and `npm_package_version` are how a build stamps itself, `npm_config_user_agent` is how a package
 * decides what registry it is talking to, and `npm_lifecycle_event` is how one script tells which of
 * the events it was written for is running it.
 *
 * The keys are npm 11.12.1's own, measured against host npm 11.12.1 under node v24.15.0, and every
 * value is this container's own: its prefixes, its home, its `node`, its npm version.
 */

/** Where the container keeps its npm: `npm_execpath`, and the prefix `npm_config_prefix` names. */
const NPM_PREFIX = '/usr/local';
const NPM_CLI = `${NPM_PREFIX}/lib/node_modules/npm/bin/npm-cli.js`;
/** `npm_config_node_gyp`, which npm sets even when nothing is compiled: node-gyp's own bin reads it. */
const NODE_GYP = `${NPM_PREFIX}/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js`;

/** npm's own `envVal`: a false is the empty string, a list is one string, an object is not a value. */
function envValue(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === false) return '';
    if (Array.isArray(value)) return value.map(envValue).join('\n\n');
    if (typeof value === 'object') return undefined;
    return String(value);
}

/**
 * npm's `package-envs.js`: the manifest fields RFC 183 puts in a script's environment, an object
 * becoming `<prefix><key>_` for the keys under it, so a package's `engines` and `bin` reach the
 * script as `npm_package_engines_node` and `npm_package_bin_<name>`.
 */
function packageEnvs(values: Record<string, unknown>, prefix: string, out: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        if (value === null || value === false) {
            out[`${prefix}${key}`] = '';
        } else if (Array.isArray(value)) {
            value.forEach((item, index) => packageEnvs({ [`${key}_${index}`]: item }, prefix, out));
        } else if (typeof value === 'object') {
            packageEnvs(value as Record<string, unknown>, `${prefix}${key}_`, out);
        } else {
            out[`${prefix}${key}`] = String(value);
        }
    }
}

export interface ScriptEnvironment {
    /** The npm command the run belongs to, as npm's own `npm_command` has it. */
    command: string;
    /** The package the script is one of. */
    packageDir: string;
    manifest: Record<string, any>;
    /** The lifecycle event being run: `prebuild`, `build`, `postbuild`, `install`, ... */
    event: string;
    /** The command line the event runs, which is what `npm_lifecycle_script` holds. */
    script: string;
    /** The environment the npm process itself was started with. */
    env: Record<string, string>;
    /** Whether the run is over the workspaces of a root, which npm's user agent reports. */
    workspaces?: boolean;
}

/**
 * The `npm_*` variables for one script of one package. The set is host npm 11.12.1's; the values
 * are this container's, so a path in them is a path here and not the one a host wrote.
 */
export function scriptEnvironment(
    fileSystem: IFileSystem,
    cwd: string,
    input: ScriptEnvironment
): Record<string, string> {
    const env: Record<string, string> = {};
    const { manifest, event, script, packageDir } = input;

    packageEnvs({
        name: manifest.name,
        version: manifest.version,
        config: manifest.config,
        engines: manifest.engines,
        bin: manifest.bin
    }, 'npm_package_', env);
    env.npm_package_json = joinPaths(packageDir, 'package.json');
    env.npm_lifecycle_event = event;
    env.npm_lifecycle_script = script;
    env.npm_command = input.command;

    const config = resolveConfig(fileSystem, cwd, input.env);
    const home = input.env.HOME ?? '/home';
    const prefix = config.prefix ?? NPM_PREFIX;
    /* The four npm always exports, and the ones its own defaults leave it exporting: a false is the
       empty string, so a boolean that is off is a variable that is there and empty. */
    const values: Record<string, unknown> = {
        audit: config.audit,
        cache: config.cache,
        fund: config.fund,
        global_prefix: prefix,
        globalconfig: joinPaths(prefix, 'etc/npmrc'),
        init_module: joinPaths(home, '.npm-init.js'),
        local_prefix: packageDir,
        node_gyp: NODE_GYP,
        noproxy: config.noproxy ?? '',
        npm_version: NPM_VERSION,
        prefix,
        update_notifier: config['update-notifier'] ?? true,
        userconfig: joinPaths(home, '.npmrc')
    };
    for (const [key, value] of Object.entries(values)) {
        const text = envValue(value);
        if (text !== undefined) env[`npm_config_${key}`] = text;
    }
    /* npm's `user-agent` template, with npm's own substitutions and its own trailing trim: the
       `ci` token is empty here, as it is in any run no CI names itself in. */
    env.npm_config_user_agent = [
        `npm/${NPM_VERSION}`,
        `node/${NODE_VERSION}`,
        CONTAINER_PLATFORM.os,
        CONTAINER_PLATFORM.cpu,
        `workspaces/${input.workspaces === true}`
    ].join(' ').trim();
    env.npm_execpath = NPM_CLI;
    env.NODE = NODE_BINARY;
    env.npm_node_execpath = NODE_BINARY;
    return env;
}
