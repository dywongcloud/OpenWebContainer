# Shell builtins and keywords

Measured against `/bin/sh` (bash 3.2.57): one fresh container boot per case, stdout, stderr and exit
code compared separately at two memory points. "Matches host" means byte-identical on those three.

- `source` — reads a script into the current shell; real files, positional args, variables, a nonzero last command and the fixed error paths (missing file aborts 1, no args aborts 2, directory and syntax diagnostics) and `--`/invalid-option handling match host.
- `.` — the POSIX spelling of `source`, handled by the same function; real files, args, variables, the four error paths and `--`/invalid-option handling match host.
- `test` — `=`, `-eq`/`-gt`, `-f`, `-d`, `-z`, `-n`, `!`, `-a` and the empty-argument case all match host (status 0/1).
- `trap` — `trap "echo t" EXIT`, `trap -l` (the full numbered signal list), bare `trap`, `trap -p EXIT` and a failing body's status match host.
- `times` — prints the host's two-line shape with a nonzero, rising user time from the container's wall clock (no OS CPU accounting exists here); the host's own CPU values vary between identical runs, so results agree timing-normalized rather than byte-for-byte.
- `umask` — `0022`, `umask 077` -> `0077`, `umask -S` and the `999` out-of-range complaint match host.
- `until` — `break`, a body that writes three lines, a true condition and the loop's final status match host.
- `suspend` — `sh: line 0: suspend: cannot suspend: no job control` and status 1 match host.
- `shift` — no-args status 1, `shift 2`, `shift 5` and `shift` inside a function match host.
- `#` — a comment alone, a trailing comment and comments inside `if`/`for` compounds match host.
- `!!` — non-interactive history expansion is off in bash 3.2, so `sh: !!: command not found` and status 127 match host; no expansion is implemented.
