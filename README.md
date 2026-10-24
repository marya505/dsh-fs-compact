# dsh-fs-compact

[![test](https://github.com/marya505/dsh-fs-compact/actions/workflows/test.yml/badge.svg)](https://github.com/marya505/dsh-fs-compact/actions/workflows/test.yml)

Token-lean filesystem tools for DeepSeek Harness (DSH): `fs_read`, `fs_grep`,
`fs_glob` and `fs_replace` with compact plain-text output, paths relative to
the session cwd, and a read-before-replace safeguard.

> Unofficial community plugin. Not affiliated with or endorsed by DeepSeek.

## Tools

| Tool | Purpose |
| --- | --- |
| `fs_read` | UTF-8 text as numbered lines, 800-line default, `offset` to continue; files above 8 MB are streamed |
| `fs_grep` | Regex search (pure JavaScript, no native binary); `mode` = `files` / `content` / `count` |
| `fs_glob` | `*`, `**`, `?`, `[a-z]`, `{a,b}` glob; returns cwd-relative paths |
| `fs_replace` | Global regex replace, validated in two phases, `dryRun` preview |

Design choices:

- plain-text output, no JSON envelope or bookkeeping fields;
- the path is printed once per group, relative to the session cwd;
- compact tool schemas to keep the prompt small;
- `fs_replace` warns when a target was never read first (or only partially read);
- no `.git`, `node_modules`, `dist`, `target` traversal.

## Install

Requires DSH `>=0.2.1-rc.3`.

```bash
# From GitHub — `dsh plugin` forwards its arguments to pnpm
dsh plugin --profile <profile> add "github:marya505/dsh-fs-compact"

# Local development checkout
dsh plugin --profile <profile> add "file:<path-to-checkout>"
```

`<profile>` is the DSH profile you use, for example `desktop`. If `dsh` is not on
`PATH`, run the CLI from your DSH installation, for example
`<DSH install>/resources/runtime/cli/bin/dsh` (`.cmd` on Windows).

**Updating.** pnpm hard-links `file:` dependencies, so an already-installed
local checkout is not refreshed by `add` alone:

```bash
dsh plugin --profile <profile> remove dsh-fs-compact
dsh plugin --profile <profile> add "file:<path-to-checkout>"
```

Restart the DSH desktop app after installing or updating.

## Enable / disable

Enabled as a profile bundle. To turn it off without uninstalling, add to
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: dsh-fs-compact
  disabled: true
```

If another installed plugin also provides file tools, disable one of the two
sets so the model is not offered overlapping tools.

## Uninstall

```bash
dsh plugin --profile <profile> remove dsh-fs-compact
```

Then restart DSH. To disable without uninstalling, use the `disabled: true`
entry above.

## Compatibility

- DSH `>=0.2.1-rc.3` (tested on `0.2.1-rc.3`).
- Node.js 20+ for development and tests.
- Pure JavaScript; no native binary and no runtime dependencies.

## Security model

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

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Semantics

**Globs.** A pattern is matched against paths relative to the searched `path`.
A pattern without `/` also matches basenames, so `*.js` stays recursive while
`src/*.js` is a one-level path filter. `include`, `exclude` and `replace`'s
`glob` all use the same implementation.

**Replacement strings.** `fs_replace` uses `String.replace`, so `$1` (capture
group), `$&` (whole match), `$<name>` (named group) and `$$` (literal `$`) are
available. Write `$$` when you want a literal dollar sign.

**Limits and failure behavior.** `fs_replace` first plans every file — counts
matches, checks `maxReplacements`, file size and the sandbox policy — and only
then writes. An over-limit call changes nothing and says so. Individual write
failures are reported as `skipped` instead of aborting the whole batch (already
written files are not rolled back).

**Scanning.** Scans stop at 50,000 files or 256 MB and say so. Symlinks are
skipped. Output is capped at 24,000 chars; `fs_grep` reports files skipped as
too large / unreadable / binary.

## Why it is a bundle, not a plain dependency

DSH's plugin list only shows **profile layers**: packages whose `package.json`
has `dsh.bundle.patch`. A plain dependency still loads if something inserts it,
but the market UI never lists it (the CLI even warns
`declares no dsh.bundle — installed as a plain dependency, not a profile layer`).

This package therefore ships:

- `package.json` → `dsh.bundle.patch: ./cordis.patch.yml`
- `cordis.patch.yml` → the `insert` entry that mounts the plugin

On `dsh plugin add`, DSH's reconcile step applies that patch and appends
`dsh-fs-compact` to `dsh.profile.bundles`, which is what makes it visible as an
installed plugin.

## Registration gotcha

`ctx.tools.register()` requires `output: { schema, render }`. Omitting
`output.schema` throws `TypeError: tool "x" must declare output { schema, render }`,
and if that throw happens inside `ctx.effect(...)` it is swallowed — the prompt
section still appears, so the plugin *looks* installed while none of its tools
exist. The schema must match the value `execute` returns; this plugin returns
`{ text: string }`.

Tools are registered under `ctx.inject(['tools'])` only. The sandbox policy is
resolved at call time, so a missing `sandboxPolicy` service cannot make the
tools silently disappear.

## Development

```bash
git clone https://github.com/marya505/dsh-fs-compact.git
cd dsh-fs-compact
node --test
```

The suite runs against `os.tmpdir()` fixtures and covers read paging/streaming,
grep modes and context merging, glob semantics, replace atomicity, policy
fail-closed behavior, error-code mapping and the registration entry.

## License

MIT © 2026 marya505
