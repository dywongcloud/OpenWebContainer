# Shell command reference

Short, measured notes on what the guest shell does for each command name and how that compares with
the host `/bin/sh` (bash 3.2.57, macOS). Values the container reports about itself are its own;
a named `[ERR_*] not supported on this runtime` line with exit 1 is a documented compatibility
boundary, not a fake host answer.

- [Builtins, control flow and job control](commands-builtins.md)
- [Builtins residual](commands-builtins-residual.md)
- [Text utilities](commands-textutils.md)
- [System, network and process utilities](commands-system.md)
