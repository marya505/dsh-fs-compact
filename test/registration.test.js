import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as entry from '../lib/index.js'

let dir
let registered
let sections

function load() {
  registered = []
  sections = []
  const ctx = {
    inject(dependencies, callback) {
      if (dependencies.includes('tools')) {
        callback({ tools: { register: tool => registered.push(tool) } })
        return
      }
      callback({
        effect: (fn) => { fn(); return () => {} },
        systemPrompt: { section: options => { sections.push(options); return options } },
      })
    },
    get: () => undefined,
    logger: { info() {}, error() {} },
  }
  entry.apply(ctx, {})
}

function execIn(cwd) {
  return { agent: { session: { id: `reg-${Math.random()}`, header: { cwd } } } }
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fs-compact-reg-'))
  load()
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

test('the package entry registers four tools and exposes no test surface', () => {
  assert.equal(entry.name, 'dsh-fs-compact')
  assert.deepEqual(
    registered.map(tool => tool.name).sort(),
    ['fs_glob', 'fs_grep', 'fs_read', 'fs_replace'],
  )
  assert.ok(!('__test' in entry))
  assert.equal(sections.length, 1)
  assert.match(sections[0].text, /Glob patterns match paths relative to/)
  assert.match(sections[0].text, /Replacement supports/)

  const replace = registered.find(tool => tool.name === 'fs_replace')
  assert.equal(replace.parameters.properties.caseInsensitive.type, 'boolean')
  assert.equal(replace.isConcurrencySafe, undefined)
  for (const tool of registered) {
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'object')
  }
  const read = registered.find(tool => tool.name === 'fs_read')
  assert.equal(read.isConcurrencySafe(), true)
})

test('execute maps ToolError codes to text instead of throwing', async () => {
  const read = registered.find(tool => tool.name === 'fs_read')
  const missing = await read.execute({ path: 'missing.txt' }, execIn(dir))
  assert.match(missing.text, /^error\[NOT_FOUND\]/)

  const directory = await read.execute({ path: '.' }, execIn(dir))
  assert.match(directory.text, /^error\[IS_DIRECTORY\]/)
})

test('execute wraps unexpected failures as INTERNAL', async () => {
  const read = registered.find(tool => tool.name === 'fs_read')
  const exec = {
    agent: {
      session: {
        id: 'reg-broken',
        header: { get cwd() { throw new Error('boom') } },
      },
    },
  }
  const result = await read.execute({ path: 'x' }, exec)
  assert.match(result.text, /^error\[INTERNAL\] boom/)
})
