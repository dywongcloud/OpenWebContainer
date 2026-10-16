/**
 * The interface every shell command module implements.
 *
 * The guest shell (runtime/capabilities/child.ts) resolves a command name to a handler in a module
 * under this directory and calls it with one context. A handler is synchronous: it reads and writes
 * through the virtual file system given to it, and it never spawns a child.
 */
import type { IFileSystem } from '../../filesystem/types';

/** What a command is given: its arguments, the shell's state, its standard input and the file system. */
export interface CommandContext {
    /** The words after the command name, quoted by the shell as a POSIX shell quotes them. */
    args: string[];
    /** The shell's working directory, as an absolute path. */
    cwd: string;
    /** The shell's environment. */
    env: Record<string, string>;
    /** The text piped or redirected into the command, or null when there is none. */
    input: string | null;
    /** The virtual file system of the container running the command. */
    fs: IFileSystem;
}

/** What a command returns. Exit codes follow the utility's convention: 0 success, 1 or 2 failure. */
export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** One command. It throws only to report something the shell cannot do at all, not for bad input. */
export type ShellCommand = (ctx: CommandContext) => CommandResult;

/** Resolves a path argument against the shell's directory: absolute paths stay, relative ones join. */
export function atPath(ctx: CommandContext, path: string): string {
    return ctx.fs.resolvePath(path, ctx.cwd);
}

/** The text a command reads: its file arguments, or its standard input when there are none. */
export function inputText(ctx: CommandContext): { name: string; text: string }[] {
    const files = ctx.args.filter((arg) => arg !== '-' && !arg.startsWith('-'));
    if (files.length === 0) return [{ name: '-', text: ctx.input ?? '' }];
    const out: { name: string; text: string }[] = [];
    for (const file of files) {
        const text = ctx.fs.readFile(atPath(ctx, file));
        if (text === undefined) throw new Error(`${file}: No such file or directory`);
        out.push({ name: file, text });
    }
    return out;
}
