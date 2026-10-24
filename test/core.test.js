import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertWriteAllowed,
  compileGlob,
  globTool,
  grepTool,
  matchGlob,
  readTool,
  replaceTool,
  setContext,
} from '../lib/core.js'

let dir
let sessionSeq = 0

function execIn(cwd = dir) {
  sessionSeq += 1
  return { agent: { session: { id: `test-${sessionSeq}`, header: { cwd } } } }
}

function policy(mode, workspaceRoot = dir) {
  setContext({
    get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot }) } : undefined,
  })
}

async function write(name, content) {
  const target = path.join(dir, name)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, content)
  return target
}

function read(name) {
  return fsp.readFile(path.join(dir, name), 'utf8')
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fs-compact-'))
  policy('workspace-write')
})

afterEach(async () => {
  setContext(undefined)
  await fsp.rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ read --- */

test('fs_read numbers lines and pages with offset', async () => {
  await write('a.txt', 'one\ntwo\nthree\n')
  const first = await readTool({ path: 'a.txt', limit: 2 }, execIn())
  assert.match(first, /^a\.txt 1-2\/4$/m)
  assert.match(first, /^1\|one$/m)
  assert.match(first, /next offset=3/)

  const second = await readTool({ path: 'a.txt', offset: 3, limit: 2 }, execIn())
  assert.match(second, /^a\.txt 3-4\/4$/m)
  assert.match(second, /^4\|$/m)
  assert.doesNotMatch(second, /next offset/)
})

test('fs_read rejects bad arguments and paths with stable codes', async () => {
  await write('a.txt', 'one\n')
  await assert.rejects(readTool({ path: 'a.txt', offset: 'abc' }, execIn()), error => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(readTool({ path: 'a.txt', limit: 0 }, execIn()), error => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(readTool({ path: 'missing.txt' }, execIn()), error => error.code === 'NOT_FOUND')
  await assert.rejects(readTool({ path: '.' }, execIn()), error => error.code === 'IS_DIRECTORY')
  await assert.rejects(readTool({ path: 'a.txt', offset: 9 }, execIn()), error => error.code === 'OUT_OF_RANGE')

  await write('bin.dat', Buffer.from([0x41, 0x00, 0x42]))
  await assert.rejects(readTool({ path: 'bin.dat' }, execIn()), error => error.code === 'BINARY')
})

test('fs_read handles CRLF and the trailing empty line', async () => {
  await write('crlf.txt', 'a\r\nb\r\n')
  const out = await readTool({ path: 'crlf.txt' }, execIn())
  assert.match(out, /^crlf\.txt 1-3\/3$/m)
  assert.match(out, /^1\|a$/m)
  assert.match(out, /^2\|b$/m)
  assert.match(out, /^3\|$/m)
})

test('fs_read streams files above the whole-read threshold', async () => {
  const many = Array.from({ length: 120000 }, (_, index) => `line ${index + 1} ${'x'.repeat(60)}`).join('\n')
  await write('big.txt', many)
  assert.ok((await fsp.stat(path.join(dir, 'big.txt'))).size > 8 * 1024 * 1024)

  const page = await readTool({ path: 'big.txt', offset: 100000, limit: 2 }, execIn())
  assert.match(page, /^big\.txt 100000-100001 \(large file; total unknown\)$/m)
  assert.match(page, /^100000\|line 100000 /m)
  assert.match(page, /next offset=100002/)

  const tail = await readTool({ path: 'big.txt', offset: 120000, limit: 10 }, execIn())
  assert.match(tail, /^big\.txt 120000-120000\/120000$/m)
  assert.match(tail, /^120000\|line 120000 /m)
  assert.doesNotMatch(tail, /next offset/)

  await write('trail.txt', `${Array.from({ length: 100000 }, (_, index) => `n${index + 1} ${'y'.repeat(90)}`).join('\n')}\n`)
  const end = await readTool({ path: 'trail.txt', offset: 100001, limit: 5 }, execIn())
  assert.match(end, /^trail\.txt 100001-100001\/100001$/m)
  assert.match(end, /^100001\|$/m)
})

/* ------------------------------------------------------------------ grep --- */

test('fs_grep supports the three modes', async () => {
  await write('src/a.js', 'alpha\nbeta\nALPHA\n')
  await write('src/sub/b.js', 'alpha\n')
  await write('src/notes.md', 'alpha\n')

  const files = await grepTool({ pattern: 'alpha', path: 'src', mode: 'files' }, execIn())
  assert.match(files, /src\/a\.js/)
  assert.match(files, /src\/sub\/b\.js/)
  assert.match(files, /src\/notes\.md/)

  const counts = await grepTool({ pattern: 'alpha', path: 'src', mode: 'count', caseInsensitive: true }, execIn())
  assert.match(counts, /total 4 matches in 3 files/)

  const content = await grepTool({ pattern: 'alpha', path: 'src/a.js', mode: 'content' }, execIn())
  assert.match(content, /src\/a\.js\n1:alpha/)
})

test('fs_grep include is relative to the searched root', async () => {
  await write('src/a.js', 'alpha\n')
  await write('src/sub/b.js', 'alpha\n')
  await write('src/notes.md', 'alpha\n')

  const shallow = await grepTool({ pattern: 'alpha', path: 'src', mode: 'files', include: ['*.js'] }, execIn())
  assert.match(shallow, /a\.js/)
  assert.match(shallow, /sub\/b\.js/)
  assert.doesNotMatch(shallow, /notes\.md/)

  const exact = await grepTool({ pattern: 'alpha', path: 'src', mode: 'files', include: ['sub/*.js'] }, execIn())
  assert.doesNotMatch(exact, /src\/a\.js/)
  assert.match(exact, /sub\/b\.js/)
})

test('fs_grep merges overlapping context blocks', async () => {
  await write('ctx.txt', 'l1\nl2\nMATCH3\nl4\nMATCH5\nl6\nl7\n')
  const out = await grepTool({ pattern: 'MATCH', path: 'ctx.txt', mode: 'content', context: 2 }, execIn())
  const lines = out.split('\n')
  assert.equal(lines.filter(line => line === '3:MATCH3').length, 1)
  assert.equal(lines.filter(line => line === '4-l4').length, 1)
  assert.equal(lines.filter(line => line === '5:MATCH5').length, 1)
  assert.equal(lines.filter(line => line === '2-l2').length, 1)
})

test('fs_grep reports skipped files instead of silently dropping them', async () => {
  await write('ok.txt', 'nothing here\n')
  await write('bin.dat', Buffer.from([0x41, 0x00, 0x42]))
  const out = await grepTool({ pattern: 'zzz', path: '.', mode: 'files' }, execIn())
  assert.match(out, /no matches \(searched 1 files; skipped 1 binary\)/)
})

test('fs_grep reports oversized files as skipped', async () => {
  await write('big.txt', 'x'.repeat(9 * 1024 * 1024))
  const out = await grepTool({ pattern: 'x', path: '.', mode: 'files' }, execIn())
  assert.match(out, /no matches \(searched 0 files; skipped 1 too large\)/)
})

test('fs_grep rejects missing roots and bad arguments', async () => {
  await assert.rejects(grepTool({ pattern: 'x', path: 'missing' }, execIn()), error => error.code === 'NOT_FOUND')
  await assert.rejects(grepTool({ pattern: 'x', limit: 'abc' }, execIn()), error => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(grepTool({ pattern: '(' }, execIn()), error => error.code === 'INVALID_PATTERN')
})

/* ------------------------------------------------------------------ glob --- */

test('fs_glob matches root-relative paths, basenames and nested globs', async () => {
  await write('a.txt', '')
  await write('b.txt', '')
  await write('c.md', '')
  await write('sub/a.txt', '')

  const star = await globTool({ pattern: ['*.txt'] }, execIn())
  assert.match(star, /^a\.txt$/m)
  assert.match(star, /^b\.txt$/m)
  assert.match(star, /^sub\/a\.txt$/m)
  assert.doesNotMatch(star, /c\.md/)

  const deep = await globTool({ pattern: ['**/*.txt'] }, execIn())
  assert.match(deep, /^a\.txt$/m)
  assert.match(deep, /^sub\/a\.txt$/m)

  const brace = await globTool({ pattern: ['{a,b}.txt'] }, execIn())
  assert.match(brace, /^a\.txt$/m)
  assert.match(brace, /^b\.txt$/m)
  assert.doesNotMatch(brace, /c\.md/)

  const klass = await globTool({ pattern: ['[ab].txt'] }, execIn())
  assert.match(klass, /^a\.txt$/m)
  assert.match(klass, /^b\.txt$/m)

  const negated = await globTool({ pattern: ['[!a].txt'] }, execIn())
  assert.doesNotMatch(negated, /^a\.txt$/m)
  assert.match(negated, /^b\.txt$/m)
})

test('fs_glob excludes basenames and accepts a file root', async () => {
  await write('a.txt', '')
  await write('b.txt', '')
  await write('sub/a.txt', '')

  const excluded = await globTool({ pattern: ['*.txt'], exclude: ['a.txt'] }, execIn())
  assert.doesNotMatch(excluded, /a\.txt/)
  assert.match(excluded, /^b\.txt$/m)

  const single = await globTool({ path: 'a.txt', pattern: ['*.txt'] }, execIn())
  assert.match(single, /^a\.txt\n\(1 files\)$/m)

  await assert.rejects(globTool({ pattern: ['*'], path: 'missing' }, execIn()), error => error.code === 'NOT_FOUND')
})

test('fs_glob reports when the limit cuts the result short', async () => {
  await write('a.txt', '')
  await write('b.txt', '')
  const out = await globTool({ pattern: ['*.txt'], limit: 1 }, execIn())
  assert.match(out, /\(1 files\)/)
  assert.match(out, /limit 1 reached/)
})

test('glob compilation handles classes, alternation and path scoping', () => {
  assert.ok(matchGlob(compileGlob('*.js'), 'sub/a.js'))
  assert.ok(matchGlob(compileGlob('src/*.js'), 'src/a.js'))
  assert.ok(!matchGlob(compileGlob('src/*.js'), 'src/sub/a.js'))
  assert.ok(matchGlob(compileGlob('**/*.js'), 'a.js'))
  assert.ok(matchGlob(compileGlob('[ab].txt'), 'a.txt'))
  assert.ok(!matchGlob(compileGlob('[!a].txt'), 'a.txt'))
  assert.ok(matchGlob(compileGlob('{a,b}.txt'), 'b.txt'))
})

/* --------------------------------------------------------------- replace --- */

test('fs_replace previews with dryRun and writes only when asked', async () => {
  await write('r.txt', 'foo foo\n')
  const preview = await replaceTool({ path: 'r.txt', pattern: 'foo', replacement: 'bar', dryRun: true }, execIn())
  assert.match(preview, /dry-run: 2 occurrences would change in 1 files/)
  assert.match(preview, /\(not read first\)/)
  assert.equal(await read('r.txt'), 'foo foo\n')

  const changed = await replaceTool({ path: 'r.txt', pattern: 'foo', replacement: 'bar' }, execIn())
  assert.match(changed, /changed: 2 occurrences in 1 files/)
  assert.equal(await read('r.txt'), 'bar bar\n')
  const entries = await fsp.readdir(dir)
  assert.ok(!entries.some(name => name.endsWith('.tmp')))
})

test('fs_replace validates maxReplacements before writing anything', async () => {
  await write('a.txt', 'x'.repeat(600))
  await write('b.txt', 'x'.repeat(600))
  await assert.rejects(
    replaceTool({ path: '.', pattern: 'x', replacement: 'y', maxReplacements: 1000 }, execIn()),
    error => error.code === 'OUTPUT_LIMIT',
  )
  assert.equal(await read('a.txt'), 'x'.repeat(600))
  assert.equal(await read('b.txt'), 'x'.repeat(600))
  assert.ok(!(await fsp.readdir(dir)).some(name => name.endsWith('.tmp')))
})

test('fs_replace distinguishes "no matches" from "matched but unchanged"', async () => {
  await write('same.txt', 'aaa\n')
  const unchanged = await replaceTool({ path: 'same.txt', pattern: 'a', replacement: 'a', dryRun: true }, execIn())
  assert.match(unchanged, /matched 3 occurrences in 1 files, but the replacement would not change the content/)

  const none = await replaceTool({ path: 'same.txt', pattern: 'zzz', replacement: 'y', dryRun: true }, execIn())
  assert.match(none, /^no matches$/m)
})

test('fs_replace supports capture groups, $&, $$ and caseInsensitive', async () => {
  await write('mail.txt', 'name@example.com\n')
  await replaceTool({ path: 'mail.txt', pattern: '(\\w+)@example\\.com', replacement: '$1@test.com' }, execIn())
  assert.equal(await read('mail.txt'), 'name@test.com\n')

  await write('price.txt', 'price: 5\n')
  await replaceTool({ path: 'price.txt', pattern: '5', replacement: '$$5' }, execIn())
  assert.equal(await read('price.txt'), 'price: $5\n')

  await write('ci.txt', 'ABC\n')
  await replaceTool({ path: 'ci.txt', pattern: 'abc', replacement: 'xyz', caseInsensitive: true }, execIn())
  assert.equal(await read('ci.txt'), 'xyz\n')
})

test('fs_replace rejects non-finite limits and oversized targets', async () => {
  await write('a.txt', 'a\n')
  await assert.rejects(
    replaceTool({ path: 'a.txt', pattern: 'a', replacement: 'b', maxReplacements: 'abc' }, execIn()),
    error => error.code === 'INVALID_ARGUMENT',
  )

  await write('huge.txt', 'x'.repeat(9 * 1024 * 1024))
  await assert.rejects(
    replaceTool({ path: 'huge.txt', pattern: 'x', replacement: 'y' }, execIn()),
    error => error.code === 'TOO_LARGE',
  )
  assert.equal((await fsp.stat(path.join(dir, 'huge.txt'))).size, 9 * 1024 * 1024)
})

test('fs_replace skips binary files and reports them', async () => {
  await write('bin.dat', Buffer.from([0x61, 0x00, 0x62]))
  await write('t.txt', 'a\n')
  const out = await replaceTool({ path: '.', pattern: 'a', replacement: 'z' }, execIn())
  assert.match(out, /changed: 1 occurrences/)
  assert.match(out, /bin\.dat \(binary\)/)
  assert.equal(await read('t.txt'), 'z\n')
})

test('fs_replace enforces the sandbox policy and fails closed on unknown modes', async () => {
  await write('p.txt', 'a\n')
  policy('read-only')
  await assert.rejects(replaceTool({ path: 'p.txt', pattern: 'a', replacement: 'b' }, execIn()), error => error.code === 'POLICY_DENIED')
  assert.equal(await read('p.txt'), 'a\n')

  policy('home-write')
  await assert.rejects(replaceTool({ path: 'p.txt', pattern: 'a', replacement: 'b' }, execIn()), error => error.code === 'POLICY_DENIED')

  setContext({ get: () => ({ resolve: () => ({ mode: 'workspace-write' }) }) })
  await assert.rejects(replaceTool({ path: 'p.txt', pattern: 'a', replacement: 'b' }, execIn()), error => error.code === 'POLICY_DENIED')

  policy('workspace-write')
  assert.throws(
    () => assertWriteAllowed({ mode: 'workspace-write', workspaceRoot: dir }, path.parse(os.tmpdir()).root),
    error => error.code === 'POLICY_DENIED',
  )
})

test('fs_replace allows danger-full-access outside the workspace', async () => {
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fs-compact-outside-'))
  try {
    const target = path.join(outsideDir, 'o.txt')
    await fsp.writeFile(target, 'a\n')
    policy('danger-full-access')
    const out = await replaceTool({ path: target, pattern: 'a', replacement: 'b' }, execIn())
    assert.match(out, /changed: 1 occurrences/)
    assert.equal(await fsp.readFile(target, 'utf8'), 'b\n')
  } finally {
    await fsp.rm(outsideDir, { recursive: true, force: true })
  }
})

test('fs_replace applies the glob filter relative to the searched root', async () => {
  await write('src/a.js', 'a\n')
  await write('src/b.md', 'a\n')
  const out = await replaceTool({ path: 'src', pattern: 'a', replacement: 'b', glob: ['*.js'] }, execIn())
  assert.match(out, /changed: 1 occurrences in 1 files/)
  assert.equal(await read('src/a.js'), 'b\n')
  assert.equal(await read('src/b.md'), 'a\n')
})

test('workspace-write still allows the temp directory', () => {
  assert.doesNotThrow(() => assertWriteAllowed(
    { mode: 'workspace-write', workspaceRoot: dir },
    path.join(os.tmpdir(), 'fs-compact-tmp-probe.txt'),
  ))
})

test('fs_replace warns about partially read files and clears the warning after a full read', async () => {
  await write('o.txt', Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n'))
  const exec = execIn()

  await readTool({ path: 'o.txt', limit: 2 }, exec)
  const partial = await replaceTool({ path: 'o.txt', pattern: 'line10', replacement: 'X', dryRun: true }, exec)
  assert.match(partial, /\(partially read\)/)

  const execFull = execIn()
  await readTool({ path: 'o.txt', limit: 2 }, execFull)
  await readTool({ path: 'o.txt', offset: 3, limit: 8 }, execFull)
  const full = await replaceTool({ path: 'o.txt', pattern: 'line10', replacement: 'X', dryRun: true }, execFull)
  assert.doesNotMatch(full, /partially read|not read first/)

  const unread = await replaceTool({ path: 'o.txt', pattern: 'line10', replacement: 'X', dryRun: true }, execIn())
  assert.match(unread, /\(not read first\)/)
})
