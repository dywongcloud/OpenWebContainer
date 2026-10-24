/**
 * The lines of a `--env-file`, as the pairs they put in `process.env`.
 *
 * Node reads one the way a `.env` is read: a line holds `NAME=value`, a blank line and one whose
 * first character is `#` say nothing, an `export` in front of the name is allowed, and the value may
 * be written in quotes -- in which case it may run over more than one line, and `\n` inside double
 * quotes is a newline. A `#` behind whitespace ends an unquoted value with a comment, `A=1 # note`
 * is 1, and nothing is expanded: `A=$HOME` is the seven characters it was written as. A line with no
 * `=` in it names nothing and is skipped.
 *
 * The pairs are handed back in the order the file wrote them, and it is the caller that decides
 * what to do with a name the environment already holds: node leaves the one it was started with.
 */
export function parseEnvFile(text: string): [string, string][] {
    const pairs: [string, string][] = [];
    const lines = text.split(/\r?\n/);
    for (let at = 0; at < lines.length; at++) {
        let line = lines[at]!.trim();
        if (line === '' || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice('export '.length).trim();
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const name = line.slice(0, eq).trim();
        if (name === '') continue;
        let value = line.slice(eq + 1).trim();
        const quote = value[0];
        if (quote === '"' || quote === "'") {
            /* A quoted value runs to its closing quote, however many lines it takes. */
            while ((value.length === 1 || !value.endsWith(quote)) && at + 1 < lines.length) {
                at++;
                value += '\n' + lines[at]!;
            }
            if (value.length > 1 && value.endsWith(quote)) {
                value = value.slice(1, -1);
                if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
            } else {
                value = stripTrailingComment(value);
            }
        } else {
            value = stripTrailingComment(value);
        }
        pairs.push([name, value]);
    }
    return pairs;
}

/** The value with the comment behind it cut off: `1 # note` is 1. */
function stripTrailingComment(value: string): string {
    const at = value.search(/\s+#/);
    return at < 0 ? value : value.slice(0, at).trim();
}
