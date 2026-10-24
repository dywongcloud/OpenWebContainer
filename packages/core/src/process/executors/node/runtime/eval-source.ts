/**
 * The source a `node -p <source>` run evaluates. Like node's -p, the expression runs in the global scope
 * (indirect eval) and its completion value is printed with console.log, so the shell and asynchronous
 * spawn paths agree on what -p prints.
 *
 * The source goes through the guest's compatibility rewrite first: an indirect eval compiles it with
 * the engine, and a for-of whose iterable holds a yield aborts that compile ('stack underflow'), which
 * is the same abort a module body is hoisted out of. A source the rewrite leaves alone is unaffected.
 */
export function printEvalSource(source: string): string {
    return `console.log((0, eval)(__owc_api.compatRewrite(${JSON.stringify(source)})));`;
}
