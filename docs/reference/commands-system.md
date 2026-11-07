# Shell command reference: system, network and process utilities

Measured against host `/bin/sh` (bash 3.2.57, macOS) and one fresh OpenWebContainer boot per case at
two memory points (loaded then free), twice per point, comparing stdout, stderr and the command's
own exit status. Values the container reports about itself are its own, never copied from the host;
a stable `[ERR_*] not supported on this runtime` line with exit 1 is a documented compatibility
boundary, and a host 127 mirrored by the container 127 is host-faithful.

- `cron` — `cron: [ERR_NO_DAEMON] ...`, exit 1; host `/usr/sbin/cron` is a daemon that never exits on these bounded cases (killed at 2 s), so no faithful daemon exists here.
- `lspci` — `lspci: [ERR_NO_PCI_BUS] ...`, exit 1; host 127 `command not found`. A PCI bus does not exist in the container; documented boundary.
- `systemctl` — `systemctl: [ERR_NO_INIT_SYSTEM] ...`, exit 1; host 127. There is no init system (one JavaScript process); documented boundary.
- `ping` — `ping: [ERR_NO_RAW_SOCKET] ...`, exit 1 on `-c 1 127.0.0.1`, `-c 1 -t 1 192.0.2.1`, `--badoption` and an unresolvable host; host answers 0/2/64/68. The virtual network is loopback TCP/UDP only with no ICMP or raw sockets, so a reply would be fabricated; the named boundary stands.
- `dh` — `dh: [ERR_NO_DEBHELPER] ...`, exit 1; host 127. No dpkg/debhelper toolchain; documented boundary.
- `netstat` — `netstat: [ERR_NO_SOCKET_TABLE] ...`, exit 1 on `-i`, `-an -p tcp`, `-Z`; host 0/0/64. No kernel socket table; documented boundary.
- `ip` — `ip: [ERR_NO_NETWORK_INTERFACES] ...`, exit 1; host 127. The virtual network has one loopback range and no interface of its own; documented boundary.
- `ssh` — `sh: ssh: command not found`, exit 127 on `-V`, `-G 127.0.0.1`, `-Q key`, `-Z`; host `/usr/bin/ssh` answers 0/0/0/255. Genuine divergence: no SSH/TCP transport leaves the browser (loopback TCP/UDP only), and printing a host version or config would be fabricated, so the 127 stands; row `owc-sh-ssh-127-vs-host-openssh` closed stale with the live measurement.
- `poweroff` — host 127 mirrored by container 127; host-faithful, no divergence.
- `restart` — host 127 mirrored by container 127; host-faithful, no divergence.
- `aspell` — host 127 mirrored by container 127; host-faithful, no divergence.
- `aptitude` — host 127 mirrored by container 127; host-faithful, no divergence.
- `nc` — `nc: [ERR_NO_SOCKET_API] ...`, exit 1 on `-h`, `-z -G 1 127.0.0.1 1`, `--version`; host 1/1/1. No socket API to connect or listen; documented boundary.
- `sntp` — `sh: sntp: command not found`, exit 127 on `--version`, bare `sntp`, `-h`, `--badoption`; host `/usr/bin/sntp` answers 64 on all four with usage diagnostics. Genuine divergence: no NTP/UDP egress and no authoritative clock, so a synced time would be fabricated; row `owc-sh-sntp-127-vs-host-ntp-client` closed stale with the live measurement.
- `tmux` — `tmux: [ERR_NO_TERMINAL] ...`, exit 1 on `-V`, `-L ... list-sessions`, `-Z`; host 0/1/1. No terminal to multiplex; documented boundary.
- `traceroute` — `traceroute: [ERR_NO_RAW_SOCKET] ...`, exit 1 on `-m 1 -w 1 127.0.0.1`, `-m 1 -w 1 192.0.2.1`, `-Z`; host 0/0/1. Needs raw ICMP/TTL sockets; documented boundary.
- `xclip` — `xclip: [ERR_NO_X_SELECTION] ...`, exit 1; host 127. No X display or selection; documented boundary.
- `kill` — implemented; `kill -l`, `kill -l 15`, `kill 999999`, bare `kill` agree with host on status and text apart from the shell's own `sh:` vs `/bin/sh:` diagnostic prefix (a documented difference owned by another lane).
- `nohup` — implemented; `nohup echo hi` and `nohup false` agree byte-for-byte. Usage errors print the host's text with status 1, where this macOS host's `/usr/bin/nohup` uses 127; an explicit design decision (127 is reserved for names the shell does not have).
- `sync` — implemented; bare, `--version` and `-h` are silent with status 0 on both sides.
- `suspend` — implemented; `suspend` and `suspend -f` agree with host status 1 and "no job control"; `suspend --badoption` differs (host 2 vs container 1) in `builtins.ts`, outside this shard's grant.
- `sleep` — implemented; `sleep 0`, `sleep 0.01`, `sleep bad`, `sleep --version` agree on status, stdout and stderr.
- `w` — implemented; `w`, `w -h`, `w --version`, `w nosuchuser` agree on status; the header, user rows and usage wording are the container's own values (no utmp, no boot clock).
- `watch` — implemented; `watch -h` and `watch --badoption` agree with host status 0/1. `watch --version` and `watch -v` now print the container's own banner `watch 0.1.0 (OpenWebContainer)` on stdout with status 0 and empty stderr, where this host's procps-ng prints `watch from procps-ng 4.0.6` with status 0; copying the host's banner would be a line about a program that is not running here. `watch -V` still reports an invalid option with status 1, as the host does. Row `owc-sh-watch-version-own-banner` resolved with a witness.
- `v` — host 127 mirrored by container 127; host-faithful, no divergence.
- `vdir` — implemented GNU-style over the virtual file system (host 127 on this macOS, as GNU/Linux hosts carry `vdir`); deliberate superset, documented in `procinfo.ts`.
- `whereis` — implemented in `procinfo.ts`: searches the container's own virtual file system for executables and manual pages, `name: <paths>` with status 0, host's option and usage-error surface (`-b`, `-m`, `-q`, `-u`, `-a`, `-B`/`-M` with `-f`, status 64). A host reports `/bin/ls /usr/share/man/man1/ls.1`; this container reports `/bin/ls` because its man tree does not exist. Row `owc-sh-whereis-127-vs-host-locates-programs` resolved with a witness.
- `tty` — implemented; `tty`, `tty -s`, `tty --version` agree byte-for-byte with host on stdout, stderr and status (1/1/2).
- `openssl` — implemented subset (`dgst`, `rand`, `version`, `help`): `openssl badcommand` matches host status/message; `version` and `help` print the container's own subset identity/content, documented in `unsupported.ts` and the Readme.

`command -v whereis` now answers `/usr/bin/whereis` with exit 0. `HOST_UTILITY_PATHS` in
`builtins.ts` has 90 measured host-utility paths including `whereis: '/usr/bin/whereis'`, and the
shell's PATH is `/bin:/usr/bin`; `command -V whereis` and `type whereis` likewise report that path
with exit 0. Rows `owc-sh-command-v-whereis-not-found` and
`owc-sh-command-v-host-utility-paths-incomplete` are resolved (see `closes/`).
