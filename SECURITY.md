# Security Policy

## Supported versions

`0.3.x` is the current release line. Older versions do not receive fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting
(**Security → Report a vulnerability**) on this repository. Do not open a
public issue for a security problem.

## Design notes

- `fs_read`, `fs_grep` and `fs_glob` are read-only. The plugin makes no network
  calls and spawns no processes.
- `fs_replace` follows the host sandbox policy resolved at call time:
  - `read-only` rejects writes;
  - `workspace-write` allows writes only inside the workspace and the OS
    temporary directory;
  - `danger-full-access` allows any writable path;
  - any other mode is rejected (fail closed).
- Directory scans skip `.git`, `node_modules` and build output, skip symlinks,
  and stop at 50,000 files / 256 MB.
- `fs_replace` validates every target (match count, file size, output size and
  policy) before writing anything; an over-limit call changes nothing.
