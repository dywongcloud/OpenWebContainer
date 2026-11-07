import type { CommandContext, CommandResult, ShellCommand } from '../shell/commands/types';
import { gitBoundaryOutcome } from './boundaries';
import { runCommand, ok, fail, GIT_HELP } from './commands';
import { GitError } from './repo';

/** A container-own version line: never the host's git binary version string. */
export const GIT_VERSION_LINE = 'git version 2.53.0-owc.1\n';

/* The sibling boundary lane owns this hook: the CLI calls it FIRST, before any
 * subcommand. It returns undefined for everything implemented here (including a
 * local-path clone) and the runtime's named outcome for everything it does not. */

export function gitMain(ctx: CommandContext): CommandResult {
    const raw = ctx.args ?? [];
    const args = raw.slice();
    let cwd = ctx.cwd || '/app';
    const overrides: Record<string, string> = { ...(ctx.env ?? {}) };
    const configOverrides: string[] = [];
    let sub: string | undefined;
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--version' || arg === '-v') return ok(GIT_VERSION_LINE);
        if (arg === '--help' || arg === '-h') return ok(GIT_HELP);
        if (arg === '-C') { cwd = args[++i] ?? cwd; continue; }
        if (arg.startsWith('-C')) { cwd = arg.slice(2); continue; }
        if (arg === '-c') { configOverrides.push(args[++i] ?? ''); continue; }
        if (arg === '-c' || arg.startsWith('-c')) { configOverrides.push(arg.slice(2)); continue; }
        if (arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace' || arg === '--exec-path' ||
            arg === '--config-env' || arg === '--super-prefix') { i++; continue; }
        if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg.startsWith('--namespace=') ||
            arg.startsWith('--exec-path=') || arg.startsWith('--config-env=') ||
            arg === '--no-pager' || arg === '-p' || arg === '-P' || arg === '--paginate' ||
            arg === '--no-replace-objects' || arg === '--no-lazy-fetch' || arg === '--no-optional-locks' ||
            arg === '--no-advice' || arg === '--bare' || arg === '--literal-pathspecs') continue;
        sub = arg; i++; break;
    }
    const rest = args.slice(i);
    if (sub === undefined) return fail(GIT_HELP, 1);
    if (sub === 'help') return ok(GIT_HELP);
    const boundary = gitBoundaryOutcome(sub, rest, overrides);
    if (boundary !== undefined) return boundary;
    const next: CommandContext = { ...ctx, cwd, env: overrides, args: rest };
    try {
        return runCommand(next, sub, rest);
    } catch (error) {
        if (error instanceof GitError) return fail(error.message, error.code);
        const gitCode = (error as unknown as { gitCode?: number }).gitCode;
        if (gitCode !== undefined) return fail(error instanceof Error ? error.message : String(error), gitCode);
        return fail('fatal: ' + (error instanceof Error ? error.message : String(error)), 128);
    }
}

export const GIT_COMMANDS: Record<string, ShellCommand> = { git: gitMain };
