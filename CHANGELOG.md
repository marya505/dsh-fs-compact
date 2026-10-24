# Changelog

## [0.3.1] - 2026-10-24

### Changed

- Published to npm as `dsh-fs-compact`. No functional changes from 0.3.0.

## [0.3.0] - 2026-10-22

### Added

- `fs_glob` supports `[abc]`, `[!abc]`, `[a-z]` and `{js,ts}`.
- `fs_replace` supports `caseInsensitive`.
- Error codes `NOT_FOUND`, `PERMISSION_DENIED`, `IS_DIRECTORY`.
- Streaming line reads for files larger than 8 MB.
- `fs_grep` reports searched / skipped counts.

### Changed

- Glob patterns (including `fs_grep` `include`) are relative to `path`;
  patterns without `/` fall back to basename matching.
- `fs_replace` validates every target before writing; limit failures change
  nothing.
- `fs_replace` now distinguishes "no matches" from "matched but unchanged".
- `fs_read` no longer rejects large files just because of `offset` / `limit`.

### Fixed

- Non-integer limits (e.g. `NaN`) no longer disable limits.
- Unknown sandbox modes fail closed.
- `fs_glob` on a file path returns that file instead of "no matches".
- Partial reads are tracked; replace warns with "(partially read)".
