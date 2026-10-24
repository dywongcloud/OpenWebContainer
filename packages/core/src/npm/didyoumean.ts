/**
 * npm's "did you mean" suggestions, as npm 11 builds them (`lib/utils/did-you-mean.js`).
 *
 * A name npm could not resolve is compared with every command npm has, then with the package's own
 * scripts and bins, and the ones within npm's own distance of it are offered with the description
 * npm prints beside each. The distance is Levenshtein's, and npm's bound is proportional to the
 * name it was given -- under 40% of its length -- so a long name tolerates more edits than a short
 * one: `start` (5) reaches `star` and `stars` at distance 1 and nothing else, while `test` (4),
 * whose bound is under 1.6, reaches no other command at all and is offered nothing.
 */

/** Every command npm has, with the one-line description npm prints beside it in a suggestion. */
const NPM_COMMANDS: readonly (readonly [string, string])[] = [
    ['access', 'Set access level on published packages'],
    ['adduser', 'Add a registry user account'],
    ['audit', 'Run a security audit'],
    ['bugs', 'Report bugs for a package in a web browser'],
    ['cache', 'Manipulates packages and npx cache'],
    ['ci', 'Clean install a project'],
    ['completion', 'Tab Completion for npm'],
    ['config', 'Manage the npm configuration files'],
    ['dedupe', 'Reduce duplication in the package tree'],
    ['deprecate', 'Deprecate a version of a package'],
    ['diff', 'The registry diff command'],
    ['dist-tag', 'Modify package distribution tags'],
    ['docs', 'Open documentation for a package in a web browser'],
    ['doctor', 'Check the health of your npm environment'],
    ['edit', 'Edit an installed package'],
    ['exec', 'Run a command from a local or remote npm package'],
    ['explain', 'Explain installed packages'],
    ['explore', 'Browse an installed package'],
    ['find-dupes', 'Find duplication in the package tree'],
    ['fund', 'Retrieve funding information'],
    ['get', 'Get a value from the npm configuration'],
    ['help', 'Get help on npm'],
    ['help-search', 'Search npm help documentation'],
    ['init', 'Create a package.json file'],
    ['install', 'Install a package'],
    ['install-ci-test', 'Install a project with a clean slate and run tests'],
    ['install-test', 'Install package(s) and run tests'],
    ['link', 'Symlink a package folder'],
    ['ll', 'List installed packages'],
    ['login', 'Login to a registry user account'],
    ['logout', 'Log out of the registry'],
    ['ls', 'List installed packages'],
    ['org', 'Manage orgs'],
    ['outdated', 'Check for outdated packages'],
    ['owner', 'Manage package owners'],
    ['pack', 'Create a tarball from a package'],
    ['ping', 'Ping npm registry'],
    ['pkg', 'Manages your package.json'],
    ['prefix', 'Display prefix'],
    ['profile', 'Change settings on your registry profile'],
    ['prune', 'Remove extraneous packages'],
    ['publish', 'Publish a package'],
    ['query', 'Retrieve a filtered list of packages'],
    ['rebuild', 'Rebuild a package'],
    ['repo', 'Open package repository page in the browser'],
    ['restart', 'Restart a package'],
    ['root', 'Display npm root'],
    ['run', 'Run arbitrary package scripts'],
    ['sbom', 'Generate a Software Bill of Materials (SBOM)'],
    ['search', 'Search for packages'],
    ['set', 'Set a value in the npm configuration'],
    ['shrinkwrap', 'Lock down dependency versions for publication'],
    ['star', 'Mark your favorite packages'],
    ['stars', 'View packages marked as favorites'],
    ['start', 'Start a package'],
    ['stop', 'Stop a package'],
    ['team', 'Manage organization teams and team memberships'],
    ['test', 'Test a package'],
    ['token', 'Manage your authentication tokens'],
    ['trust', 'Create a trusted relationship between a package and a OIDC provider'],
    ['undeprecate', 'Undeprecate a version of a package'],
    ['uninstall', 'Remove a package'],
    ['unpublish', 'Remove a package from the registry'],
    ['unstar', 'Remove an item from your favorite packages'],
    ['update', 'Update packages'],
    ['version', 'Bump a package version'],
    ['view', 'View registry info'],
    ['whoami', 'Display npm username']
];

/**
 * The scripts npm leaves out of the suggestions: `npm start` and the rest are commands of npm's
 * own, and npm says it would already be suggesting them through `npm x`.
 */
const RUN_SCRIPTS = ['stop', 'start', 'test', 'restart'] as const;

/** Levenshtein distance: the fewest single-character edits that turn `left` into `right`. */
export function levenshtein(left: string, right: string): number {
    if (left === right) return 0;
    if (left.length === 0) return right.length;
    if (right.length === 0) return left.length;
    let previous = new Array<number>(right.length + 1);
    let current = new Array<number>(right.length + 1);
    for (let j = 0; j <= right.length; j++) previous[j] = j;
    for (let i = 1; i <= left.length; i++) {
        current[0] = i;
        for (let j = 1; j <= right.length; j++) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
        }
        const swap = previous;
        previous = current;
        current = swap;
    }
    return previous[right.length];
}

/** npm's own test for "close enough to suggest": a distance under 40% of the name it was given. */
function isClose(name: string, candidate: string): boolean {
    return levenshtein(name, candidate) < name.length * 0.4;
}

/** The names of the bins a package declares, whichever of npm's two spellings its `bin` has. */
function binNames(manifest: Record<string, any> | undefined): string[] {
    const bin = manifest?.bin;
    if (typeof bin === 'string') return [String(manifest?.name ?? '').split('/').pop() || 'bin'];
    if (bin && typeof bin === 'object') return Object.keys(bin as Record<string, unknown>);
    return [];
}

/**
 * The suggestion block npm puts behind an error, or the empty string when nothing is close: two
 * newlines and the question, then up to three `npm <what> # <description>` lines.
 */
export function didYouMean(manifest: Record<string, any> | undefined, name: string): string {
    const scripts = (manifest?.scripts ?? {}) as Record<string, unknown>;
    const best: [string, string][] = [];
    for (const [command, description] of NPM_COMMANDS) {
        if (command !== name && isClose(name, command)) best.push([command, description]);
    }
    for (const script of Object.keys(scripts)) {
        /* A script npm's own commands already cover is left out: `npm start` is a command. */
        if (!RUN_SCRIPTS.includes(script as typeof RUN_SCRIPTS[number]) && isClose(name, script)) {
            best.push([`run ${script}`, `run the "${script}" package script`]);
        }
    }
    for (const bin of binNames(manifest)) {
        if (isClose(name, bin)) best.push([`exec ${bin}`, `run the "${bin}" command from either this or a remote npm package`]);
    }
    if (best.length === 0) return '';
    return `\n\nDid you mean ${best.length === 1 ? 'this' : 'one of these'}?\n` +
        best.slice(0, 3).map(([what, description]) => `  npm ${what} # ${description}`).join('\n');
}
