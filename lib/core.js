/**
 * dsh-fs-compact core — implementations behind the fs_* tools.
 *
 * Kept separate from the registration entry (`lib/index.js`) so tests can import
 * the implementations without exposing a test surface from the package entry.
 *
 * Design goals:
 *  - plain-text output: no JSON envelope, path printed once;
 *  - paths rendered relative to the session cwd;
 *  - read-before-replace is tracked and reported;
 *  - limits are validated before anything is written;
 *  - unknown sandbox policies fail closed.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '.cache', '__pycache__', '.venv', 'venv', '.idea', 'coverage', '.turbo',
])
const MAX_SCAN_FILES = 50000
const MAX_SCAN_BYTES = 256 * 1024 * 1024
const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_REPLACE_BYTES = 8 * 1024 * 1024
const MAX_WRITE_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_CHARS = 24000
const MAX_PAGE_CHARS = 8 * 1024 * 1024
const MAX_LINE_CHARS = 1024 * 1024
const OBSERVED_MAX_FILES = 2000
const POLICY_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const GREP_MODES = new Set(['files', 'content', 'count'])
const LINE_PREVIEW_CHARS = 400

export class ToolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

function fail(code, message) {
  return new ToolError(code, message)
}

/* ---------------------------------------------------------------- helpers --- */

function intArg(raw, name, min, max, fallback) {
  if (raw === undefined || raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw fail('INVALID_ARGUMENT', `${name} must be an integer`)
  }
  if (value < min || value > max) {
    throw fail('INVALID_ARGUMENT', `${name} must be between ${min} and ${max}`)
  }
  return value
}

function absolute(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0) throw fail('INVALID_ARGUMENT', 'path must be a non-empty string')
  if (raw.includes('\0')) throw fail('INVALID_ARGUMENT', 'path contains a NUL byte')
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}

function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('NO_CWD', 'session cwd is unavailable')
  return cwd
}

function sessionOf(exec) {
  return String(exec?.agent?.session?.id ?? 'unknown')
}

function display(cwd, target) {
  const relative = path.relative(cwd, target)
  const text = relative === ''
    ? '.'
    : relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? target
      : relative
  return text.split(path.sep).join('/')
}

function relativeFrom(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/')
}

function buildRegex(source, caseInsensitive = false, forceGlobal = false) {
  if (typeof source !== 'string' || source.length === 0) throw fail('INVALID_ARGUMENT', 'pattern must be a non-empty string')
  let flags = caseInsensitive ? 'i' : ''
  if (forceGlobal) flags += 'g'
  try {
    return new RegExp(source, flags)
  } catch (error) {
    throw fail('INVALID_PATTERN', `invalid regex: ${error.message}`)
  }
}

/* ----------------------------------------------------------------- globs --- */

const REGEX_SPECIAL = '\\^$+.()|'

function globSource(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) {
        out += '\\['
        continue
      }
      let body = pattern.slice(i + 1, end)
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      body = body.replace(/\\/g, '\\\\')
      out += `[${body}]`
      i = end
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i + 1)
      if (end === -1) {
        out += '\\{'
        continue
      }
      const body = pattern.slice(i + 1, end)
      const alternatives = body.split(',')
      if (alternatives.length < 2) {
        out += `\\{${body.replace(new RegExp(`[${REGEX_SPECIAL}]`, 'g'), '\\$&')}\\}`
      } else {
        out += `(?:${alternatives.map(globSource).join('|')})`
      }
      i = end
    } else if (ch === '}' || ch === ']') {
      out += `\\${ch}`
    } else if (REGEX_SPECIAL.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return out
}

export function compileGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw fail('INVALID_ARGUMENT', 'glob must be a non-empty string')
  }
  return {
    pattern,
    hasSlash: pattern.includes('/'),
    regex: new RegExp(`^${globSource(pattern)}$`),
  }
}

/**
 * Match a glob against a path relative to the searched root.
 * Patterns without `/` also match the basename, so `*.js` stays recursive
 * while `src/*.js` is an exact one-level path filter.
 */
export function matchGlob(compiled, rel) {
  if (compiled.regex.test(rel)) return true
  if (compiled.hasSlash) return false
  return compiled.regex.test(path.posix.basename(rel))
}

/* ------------------------------------------------------------------ walk --- */

export function newScanState() {
  return { files: 0, bytes: 0, truncated: false, reason: null, statSkipped: 0, unreadableDirs: 0 }
}

async function* walk(root, state = newScanState()) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      state.unreadableDirs += 1
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      let size
      try {
        size = (await fsp.stat(full)).size
      } catch {
        state.statSkipped += 1
        continue
      }
      state.files += 1
      if (state.files > MAX_SCAN_FILES) {
        state.truncated = true
        state.reason = `file limit ${MAX_SCAN_FILES}`
        return
      }
      state.bytes += size
      if (state.bytes > MAX_SCAN_BYTES) {
        state.truncated = true
        state.reason = `byte limit ${MAX_SCAN_BYTES}`
        return
      }
      yield full
    }
  }
}

function scanNote(state) {
  return state.truncated ? `\n[scan stopped: ${state.reason}; narrow path or glob]` : ''
}

/* --------------------------------------------------------------- policy --- */

function resolvePolicy(ctx, exec) {
  const session = exec?.agent?.session
  const service = ctx?.get?.('sandboxPolicy')
  let policy
  try {
    policy = service?.resolve?.({ session })
  } catch {
    policy = undefined
  }
  if (!policy || typeof policy.mode !== 'string') {
    return { mode: 'workspace-write', workspaceRoot: exec?.agent?.session?.header?.cwd }
  }
  return policy
}

function policyKey(policy) {
  return `${policy?.mode ?? ''}\0${policy?.workspaceRoot ?? ''}`
}

function inside(root, target) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return false
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Fail closed: only the three modes DSH defines are recognized. Anything else
 * (a future mode this plugin does not understand) is denied instead of allowed.
 */
export function assertWriteAllowed(policy, target) {
  if (!policy || !POLICY_MODES.has(policy.mode)) {
    throw fail('POLICY_DENIED', `unsupported sandbox policy mode "${policy?.mode}"; no files were changed`)
  }
  if (policy.mode === 'danger-full-access') return
  if (policy.mode === 'read-only') {
    throw fail('POLICY_DENIED', 'session is read-only; no files were changed')
  }
  if (typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) {
    throw fail('POLICY_DENIED', 'workspace-write policy has no usable workspaceRoot; no files were changed')
  }
  const roots = [policy.workspaceRoot, os.tmpdir()]
  if (!roots.some(root => inside(root, target))) {
    throw fail('POLICY_DENIED', `workspace-write allows changes only inside the workspace or the temp directory; '${target}' is outside`)
  }
}

/* ---------------------------------------------------------------- errors --- */

function fsError(error, shown) {
  switch (error?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return fail('NOT_FOUND', `'${shown}' does not exist`)
    case 'EACCES':
    case 'EPERM':
      return fail('PERMISSION_DENIED', `permission denied: '${shown}'`)
    case 'EISDIR':
      return fail('IS_DIRECTORY', `'${shown}' is a directory; use fs_glob`)
    default:
      return error
  }
}

function codeLabel(error) {
  if (error instanceof ToolError) return error.code
  return error?.code ?? 'ERROR'
}

async function statOrThrow(target, shown) {
  try {
    return await fsp.stat(target)
  } catch (error) {
    throw fsError(error, shown)
  }
}

async function readTextOrThrow(file, shown) {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (error) {
    throw fsError(error, shown)
  }
}

async function looksBinary(file, shown) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch (error) {
    throw fsError(error, shown)
  }
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } catch (error) {
    throw fsError(error, shown)
  } finally {
    await handle.close().catch(() => {})
  }
}

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[truncated: ${text.length - limit} more chars; narrow the query]`
    : text
}

/* ------------------------------------------------------- observed tracking --- */

const observed = new Map()

function observedEntry(session, file) {
  const key = path.resolve(file)
  let map = observed.get(session)
  if (!map) observed.set(session, (map = new Map()))
  let entry = map.get(key)
  if (!entry) {
    entry = { full: false, ranges: [] }
    map.set(key, entry)
    if (map.size > OBSERVED_MAX_FILES) map.delete(map.keys().next().value)
  }
  return entry
}

function markObserved(session, file, { from, to, total, full = false } = {}) {
  const entry = observedEntry(session, file)
  if (full) {
    entry.full = true
    entry.ranges = []
    return
  }
  if (entry.full) return
  entry.ranges.push([from, to])
  entry.ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of entry.ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  if (typeof total === 'number' && merged.length && merged[0][0] === 1 && merged[merged.length - 1][1] >= total) {
    entry.full = true
    entry.ranges = []
    return
  }
  entry.ranges = merged.slice(-50)
}

function observationState(session, file) {
  const entry = observed.get(session)?.get(path.resolve(file))
  if (!entry) return 'none'
  return entry.full ? 'full' : 'partial'
}

function observationNote(session, file) {
  const state = observationState(session, file)
  if (state === 'full') return ''
  return state === 'partial' ? ' (partially read)' : ' (not read first)'
}

/* ------------------------------------------------------------ read helpers --- */

/**
 * Stream a page of lines without loading the whole file. Lines longer than
 * MAX_LINE_CHARS are truncated (with a marker) instead of being buffered.
 */
async function collectLines(file, offset, limit, shown) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch (error) {
    throw fsError(error, shown)
  }
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const lines = []
  let carry = ''
  let dropping = false
  let lastWasNewline = false
  let lineNumber = 0
  let reachedEof = false
  let pageChars = 0

  const pushLine = () => {
    lineNumber += 1
    if (lineNumber < offset) return
    let line = carry
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (dropping) line = `${line} …[line truncated at ${MAX_LINE_CHARS} chars]`
    lines.push(line)
    pageChars += line.length
  }

  try {
    while (lines.length < limit && pageChars < MAX_PAGE_CHARS) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) {
        reachedEof = true
        break
      }
      const chunk = decoder.write(buffer.subarray(0, bytesRead))
      let cursor = 0
      while (cursor < chunk.length) {
        const newline = chunk.indexOf('\n', cursor)
        const piece = newline === -1 ? chunk.slice(cursor) : chunk.slice(cursor, newline)
        if (piece.length) {
          lastWasNewline = false
          if (!dropping) {
            const room = MAX_LINE_CHARS - carry.length
            if (piece.length > room) {
              carry += piece.slice(0, room)
              dropping = true
            } else {
              carry += piece
            }
          }
        }
        if (newline === -1) break
        pushLine()
        lastWasNewline = true
        carry = ''
        dropping = false
        cursor = newline + 1
        if (lines.length >= limit || pageChars >= MAX_PAGE_CHARS) break
      }
    }
    if (reachedEof) {
      const rest = decoder.end()
      if (rest) {
        carry += rest
        lastWasNewline = false
      }
    }
    if (reachedEof && (carry.length || lastWasNewline) && lines.length < limit) pushLine()
  } finally {
    await handle.close().catch(() => {})
  }

  const stoppedByLimit = lines.length >= limit
  return { lines, reachedEof, pageCapped: !reachedEof && !stoppedByLimit }
}

async function collectFiles(root, globs, scan) {
  const wanted = Array.isArray(globs) && globs.length
    ? globs.filter(value => typeof value === 'string' && value.length).map(compileGlob)
    : null
  const output = []
  for await (const file of walk(root, scan)) {
    if (wanted) {
      const rel = relativeFrom(root, file)
      if (!wanted.some(compiled => matchGlob(compiled, rel))) continue
    }
    output.push(file)
  }
  return output
}

function contextRanges(hits, contextLines, lineCount) {
  const ranges = []
  for (const hit of hits) {
    const from = Math.max(0, hit - contextLines)
    const to = Math.min(lineCount - 1, hit + contextLines)
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else ranges.push([from, to])
  }
  return ranges
}

function countMatches(regex, text, stopAfter = Infinity) {
  let count = 0
  for (const _ of text.matchAll(regex)) {
    count += 1
    if (count >= stopAfter) break
  }
  return count
}

function skipSummary(counters) {
  const parts = []
  if (counters.large) parts.push(`${counters.large} too large`)
  if (counters.unreadable) parts.push(`${counters.unreadable} unreadable`)
  if (counters.binary) parts.push(`${counters.binary} binary`)
  if (counters.filtered) parts.push(`${counters.filtered} filtered`)
  return parts.length ? `; skipped ${parts.join(', ')}` : ''
}

async function writeViaTemp(file, content, mode) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    await fsp.writeFile(temporary, content, 'utf8')
    if (typeof mode === 'number') await fsp.chmod(temporary, mode & 0o7777).catch(() => {})
    await fsp.rename(temporary, file)
  } finally {
    await fsp.unlink(temporary).catch(() => {})
  }
}

/* ----------------------------------------------------------------- tools --- */

export async function readTool(args, exec) {
  const cwd = cwdOf(exec)
  const target = absolute(args.path, cwd)
  const shown = display(cwd, target)
  const stat = await statOrThrow(target, shown)
  if (stat.isDirectory()) throw fail('IS_DIRECTORY', `'${shown}' is a directory; use fs_glob`)
  if (!stat.isFile()) throw fail('NOT_FILE', `'${shown}' is not a regular file`)

  const offset = intArg(args.offset, 'offset', 1, Number.MAX_SAFE_INTEGER, 1)
  const limit = intArg(args.limit, 'limit', 1, 5000, 800)
  const session = sessionOf(exec)

  if (await looksBinary(target, shown)) {
    throw fail('BINARY', `'${shown}' looks binary; use host tooling to inspect it`)
  }

  if (stat.size <= MAX_READ_BYTES) {
    const text = await readTextOrThrow(target, shown)
    const lines = text.split(/\r?\n/)
    if (offset > lines.length) {
      throw fail('OUT_OF_RANGE', `offset ${offset} is past the end (${lines.length} lines)`)
    }
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const last = offset - 1 + slice.length
    markObserved(session, target, { from: offset, to: last, total: lines.length })
    const body = truncate(slice.map((line, index) => `${offset + index}|${line}`).join('\n'))
    const head = `${shown} ${offset}-${last}/${lines.length}`
    const tail = last < lines.length ? `\n[next offset=${last + 1}]` : ''
    return `${head}\n${body}${tail}`
  }

  const { lines, reachedEof } = await collectLines(target, offset, limit, shown)
  if (!lines.length) {
    throw fail('OUT_OF_RANGE', `offset ${offset} is past the end (large file; total unknown)`)
  }
  const last = offset + lines.length - 1
  const total = reachedEof ? offset - 1 + lines.length : null
  markObserved(session, target, { from: offset, to: last, total: total ?? undefined })
  const body = truncate(lines.map((line, index) => `${offset + index}|${line}`).join('\n'))
  const head = total === null
    ? `${shown} ${offset}-${last} (large file; total unknown)`
    : `${shown} ${offset}-${last}/${total}`
  const tail = reachedEof ? '' : `\n[next offset=${last + 1}]`
  return `${head}\n${body}${tail}`
}

export async function grepTool(args, exec) {
  const cwd = cwdOf(exec)
  const root = absolute(args.path ?? '.', cwd)
  const shownRoot = display(cwd, root)
  const regex = buildRegex(args.pattern, args.caseInsensitive === true)
  const mode = GREP_MODES.has(args.mode) ? args.mode : 'files'
  const limit = intArg(args.limit, 'limit', 1, 2000, mode === 'count' ? 300 : 200)
  const contextLines = intArg(args.context, 'context', 0, 5, 0)
  const includes = Array.isArray(args.include) && args.include.length
    ? args.include.filter(value => typeof value === 'string' && value.length).map(compileGlob)
    : null
  const stat = await statOrThrow(root, shownRoot)
  const rootDir = stat.isFile() ? path.dirname(root) : root
  const scan = newScanState()
  const counters = { searched: 0, large: 0, unreadable: 0, binary: 0, filtered: 0 }
  const files = []
  const counts = []
  const blocks = []
  let matchedLines = 0
  let budgetHit = false
  let limitHit = false

  const candidates = stat.isFile() ? [root] : walk(root, scan)
  for await (const file of candidates) {
    const relRoot = relativeFrom(rootDir, file)
    if (includes && !includes.some(compiled => matchGlob(compiled, relRoot))) {
      counters.filtered += 1
      continue
    }
    let fileStat
    try {
      fileStat = await fsp.stat(file)
    } catch {
      counters.unreadable += 1
      continue
    }
    if (fileStat.size > MAX_READ_BYTES) {
      counters.large += 1
      continue
    }
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      counters.unreadable += 1
      continue
    }
    if (text.includes('\0')) {
      counters.binary += 1
      continue
    }
    counters.searched += 1

    const lines = text.split(/\r?\n/)
    const hits = []
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index])) hits.push(index)
    }
    if (!hits.length) continue

    const rel = display(cwd, file)
    files.push(rel)
    counts.push(`${rel} ${hits.length}`)

    if (mode === 'content') {
      const hitSet = new Set(hits)
      const rendered = []
      let chars = 0
      outer: for (const [from, to] of contextRanges(hits, contextLines, lines.length)) {
        for (let cursor = from; cursor <= to; cursor += 1) {
          const marker = hitSet.has(cursor) ? ':' : '-'
          const raw = lines[cursor]
          const preview = raw.length > LINE_PREVIEW_CHARS
            ? `${raw.slice(0, LINE_PREVIEW_CHARS)} …(+${raw.length - LINE_PREVIEW_CHARS} chars)`
            : raw
          const line = `${cursor + 1}${marker}${preview}`
          rendered.push(line)
          chars += line.length + 1
          if (chars >= MAX_OUTPUT_CHARS) {
            budgetHit = true
            break outer
          }
        }
      }
      blocks.push([rel, rendered])
      matchedLines += hits.length
      if (budgetHit) break
    }
    if (files.length >= limit) {
      limitHit = true
      break
    }
  }

  const notes = []
  if (scan.truncated) notes.push(`scan stopped: ${scan.reason}`)
  if (budgetHit) notes.push('output truncated; narrow the query')
  else if (limitHit) notes.push(`limit ${limit} reached; narrow the search`)

  if (!files.length) {
    return `no matches (searched ${counters.searched} files${skipSummary(counters)})${notes.length ? `\n[${notes.join('; ')}]` : ''}`
  }
  if (mode === 'files') {
    return truncate(`${files.join('\n')}${notes.length ? `\n[${notes.join('; ')}]` : ''}`)
  }
  if (mode === 'count') {
    const total = counts.reduce((sum, line) => sum + Number(line.split(' ').pop()), 0)
    return truncate(`${counts.join('\n')}\ntotal ${total} matches in ${files.length} files${notes.length ? `\n[${notes.join('; ')}]` : ''}`)
  }
  const body = blocks.map(([rel, rendered]) => `${rel}\n${rendered.join('\n')}`).join('\n')
  return `${body}\n${matchedLines} matches in ${files.length} files${budgetHit ? ' (partial)' : ''}${notes.length ? `\n[${notes.join('; ')}]` : ''}`
}

export async function globTool(args, exec) {
  const cwd = cwdOf(exec)
  const root = absolute(args.path ?? '.', cwd)
  const shownRoot = display(cwd, root)
  const patterns = (Array.isArray(args.pattern) ? args.pattern : [args.pattern])
    .filter(value => typeof value === 'string' && value.length)
  if (!patterns.length) throw fail('INVALID_ARGUMENT', 'pattern must contain at least one glob')
  const matchers = patterns.map(compileGlob)
  const excludePatterns = (Array.isArray(args.exclude) ? args.exclude : [])
    .filter(value => typeof value === 'string' && value.length)
    .map(compileGlob)
  const limit = intArg(args.limit, 'limit', 1, 5000, 500)
  const stat = await statOrThrow(root, shownRoot)
  const rootDir = stat.isFile() ? path.dirname(root) : root
  const scan = newScanState()
  const found = []

  const matches = rel => matchers.some(compiled => matchGlob(compiled, rel))
    && !excludePatterns.some(compiled => matchGlob(compiled, rel))

  if (stat.isFile()) {
    const rel = relativeFrom(rootDir, root)
    if (matches(rel)) found.push(display(cwd, root))
  } else {
    for await (const file of walk(root, scan)) {
      const rel = relativeFrom(rootDir, file)
      if (!matches(rel)) continue
      found.push(display(cwd, file))
      if (found.length >= limit) break
    }
  }

  found.sort()
  if (!found.length) return `no matches${scanNote(scan)}`
  const tail = found.length >= limit ? `\n[limit ${limit} reached]` : ''
  return truncate(`${found.join('\n')}\n(${found.length} files)${tail}${scanNote(scan)}`)
}

export async function replaceTool(args, exec) {
  const cwd = cwdOf(exec)
  const root = absolute(args.path, cwd)
  const shownRoot = display(cwd, root)
  const regex = buildRegex(args.pattern, args.caseInsensitive === true, true)
  const replacement = String(args.replacement ?? '')
  const max = intArg(args.maxReplacements, 'maxReplacements', 1, 100000, 1000)
  const dryRun = args.dryRun === true
  const session = sessionOf(exec)
  const policy = resolvePolicy(ctxRef, exec)
  const stat = await statOrThrow(root, shownRoot)
  const rootDir = stat.isFile() ? path.dirname(root) : root

  if (stat.isFile() && stat.size > MAX_REPLACE_BYTES) {
    throw fail('TOO_LARGE', `'${shownRoot}' is ${stat.size} bytes, above the ${MAX_REPLACE_BYTES}-byte replace limit; no files were changed`)
  }

  const scan = newScanState()
  const candidates = stat.isFile() ? [root] : await collectFiles(root, args.glob, scan)
  const skipped = []
  const unchanged = []
  const plan = []
  let matchedTotal = 0

  for (const file of candidates) {
    const rel = display(cwd, file)
    let fileStat
    try {
      fileStat = await fsp.stat(file)
    } catch (error) {
      skipped.push(`${rel} (${codeLabel(error)})`)
      continue
    }
    if (fileStat.size > MAX_REPLACE_BYTES) {
      skipped.push(`${rel} (too large: ${fileStat.size} bytes)`)
      continue
    }
    let text
    try {
      text = await readTextOrThrow(file, rel)
    } catch (error) {
      skipped.push(`${rel} (${codeLabel(error)})`)
      continue
    }
    if (text.includes('\0')) {
      skipped.push(`${rel} (binary)`)
      continue
    }
    const remaining = max - matchedTotal
    const hits = countMatches(regex, text, remaining + 1)
    if (!hits) continue
    if (hits > remaining) {
      throw fail('OUTPUT_LIMIT', `matched more than maxReplacements=${max}; no files were changed`)
    }
    matchedTotal += hits
    const next = text.replace(regex, replacement)
    if (next === text) {
      unchanged.push(rel)
      continue
    }
    const nextBytes = Buffer.byteLength(next, 'utf8')
    if (nextBytes > MAX_WRITE_BYTES) {
      throw fail('OUTPUT_LIMIT', `'${rel}' would grow to ${nextBytes} bytes, above the ${MAX_WRITE_BYTES}-byte write limit; no files were changed`)
    }
    assertWriteAllowed(policy, file)
    plan.push({
      file,
      rel,
      hits,
      note: observationNote(session, file),
      mode: fileStat.mode,
    })
  }

  const planTotal = plan.reduce((sum, item) => sum + item.hits, 0)
  const planLines = plan.map(item => `${item.rel}: ${item.hits}${item.note}`)
  const buildNotes = () => {
    const notes = []
    if (unchanged.length) {
      notes.push(`unchanged: ${unchanged.length} file(s) matched but the replacement produced identical content`)
    }
    if (skipped.length) {
      notes.push(`skipped: ${skipped.slice(0, 20).join('; ')}${skipped.length > 20 ? `; …+${skipped.length - 20} more` : ''}`)
    }
    if (scan.truncated) notes.push(`scan stopped: ${scan.reason}`)
    return notes
  }

  if (dryRun) {
    if (!plan.length) {
      const notes = buildNotes()
      if (unchanged.length) {
        return `matched ${matchedTotal} occurrences in ${unchanged.length} files, but the replacement would not change the content${notes.length ? `\n[${notes.join('; ')}]` : ''}`
      }
      return `no matches${notes.length ? `\n[${notes.join('; ')}]` : ''}`
    }
    return [`dry-run: ${planTotal} occurrences would change in ${plan.length} files`, ...planLines, ...buildNotes()].join('\n')
  }

  const policyNow = resolvePolicy(ctxRef, exec)
  if (policyKey(policyNow) !== policyKey(policy)) {
    throw fail('POLICY_DENIED', 'sandbox permissions changed while planning; no files were changed')
  }

  let changedTotal = 0
  const written = []
  for (const item of plan) {
    const note = item.note
    try {
      assertWriteAllowed(policyNow, item.file)
      const text = await readTextOrThrow(item.file, item.rel)
      const hits = countMatches(regex, text, max + 1)
      if (hits !== item.hits) {
        skipped.push(`${item.rel} (changed while planning: ${item.hits} → ${hits} matches)`)
        continue
      }
      const next = text.replace(regex, replacement)
      if (next === text) {
        unchanged.push(item.rel)
        continue
      }
      await writeViaTemp(item.file, next, item.mode)
    } catch (error) {
      skipped.push(`${item.rel} (${codeLabel(error)})`)
      continue
    }
    markObserved(session, item.file, { full: true })
    changedTotal += item.hits
    written.push(`${item.rel}: ${item.hits}${note}`)
  }

  if (!written.length) {
    const notes = buildNotes()
    if (matchedTotal) {
      return `matched ${matchedTotal} occurrences but no files were changed${notes.length ? `\n[${notes.join('; ')}]` : ''}`
    }
    return `no matches${notes.length ? `\n[${notes.join('; ')}]` : ''}`
  }
  return [`changed: ${changedTotal} occurrences in ${written.length} files`, ...written, ...buildNotes()].join('\n')
}

/* ---------------------------------------------------------------- context --- */

let ctxRef = { get: () => undefined }

export function setContext(ctx) {
  ctxRef = ctx ?? { get: () => undefined }
}
