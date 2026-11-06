# Residual builtins divergences

- `owc-sh-set-e-abort` — a failing command under `set -e` now ends a `sh -c` line that the host runs as fragments, with that command's status; a top-level `ExitSignal` marks the shell ended, so `set -e; false; echo after` is empty and exits 1 as on `/bin/sh` bash 3.2.
- `owc-sh-sourced-command-not-found-prefix` — a diagnostic raised inside a sourced file now names that file as typed with its 1-based line (`/tmp/s.sh: line 2: q: command not found`) instead of `sh: line 1: ...`; the label follows nested sources and function bodies to the file they were defined in.
- `owc-sh-exec-missing-program-abort` — `exec` of a missing program now ends the run with 126/127 and prints nothing behind it; the already host-identical two-line diagnostic is unchanged.
