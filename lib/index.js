/**
 * dsh-fs-compact — token-lean filesystem tools for DSH.
 *
 * Registration entry only. The implementations live in `lib/core.js` so they
 * can be tested without exposing an internal test surface from the package.
 */
import { ToolError, grepTool, globTool, readTool, replaceTool, setContext } from './core.js'

export const name = 'dsh-fs-compact'

const TOOLS = [
  {
    name: 'fs_read',
    description: 'Read a UTF-8 text file as numbered lines. Default 800 lines; use offset to continue. Large files are streamed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 5000 },
      },
    },
    run: readTool,
    safe: true,
  },
  {
    name: 'fs_grep',
    description: 'Regex search. mode files|content|count; include[] matches paths relative to path. Skips .git, node_modules, build output.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        mode: { type: 'string', enum: ['files', 'content', 'count'] },
        include: { type: 'array', items: { type: 'string' } },
        caseInsensitive: { type: 'boolean' },
        context: { type: 'integer', minimum: 0, maximum: 5 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
    },
    run: grepTool,
    safe: true,
  },
  {
    name: 'fs_glob',
    description: 'Find files by glob (*, **, ?, [], {}). Patterns match paths relative to path; returns cwd-relative paths.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'array', minItems: 1, items: { type: 'string' } },
        path: { type: 'string' },
        exclude: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 5000 },
      },
    },
    run: globTool,
    safe: true,
  },
  {
    name: 'fs_replace',
    description: 'Regex replace; validates maxReplacements and size before writing. dryRun previews; replacement supports $1/$&/$$.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'pattern', 'replacement'],
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string' },
        replacement: { type: 'string' },
        glob: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
        maxReplacements: { type: 'integer', minimum: 1, maximum: 100000 },
        caseInsensitive: { type: 'boolean' },
      },
    },
    run: replaceTool,
    safe: false,
  },
]

const SECTION = `# Compact file tools (fs_*)

| Task | Tool |
| --- | --- |
| Read text | fs_read |
| Search contents | fs_grep |
| Find paths | fs_glob |
| Batch replace | fs_replace |

- Output is plain text, relative to the session cwd.
- Glob patterns match paths relative to \`path\`; patterns without \`/\` also match basenames (\`*.js\` is recursive).
- fs_replace validates the match count and output size before writing anything; dryRun previews. Replacement supports \`$1\`, \`$&\`, \`$$\`; use \`$$\` for a literal \`$\`.
- fs_read pages with offset/limit; large files are streamed.
- Read-only sessions reject fs_replace; workspace-write confines it to the workspace and temp directory; unknown policies are denied.
- Scans stop at 50000 files / 256MB; symlinks are skipped; output is capped at 24000 chars.`

export function apply(ctx, config = {}) {
  setContext(ctx)
  ctx.inject(['tools'], inner => {
    for (const tool of TOOLS) {
      try {
        inner.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.safe ? { isConcurrencySafe: () => true } : {}),
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } } },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          async execute(args, exec) {
            try {
              return { text: await tool.run(args ?? {}, exec) }
            } catch (error) {
              const code = error instanceof ToolError ? error.code : 'INTERNAL'
              const detail = code === 'INTERNAL' && error?.code ? ` ${error.code}` : ''
              return { text: `error[${code}]${detail} ${String(error?.message ?? error)}` }
            }
          },
        })
      } catch (error) {
        ctx.logger?.error?.(`dsh-fs-compact: register ${tool.name} failed: ${error?.message ?? error}`)
      }
    }
    ctx.logger?.info?.(`dsh-fs-compact: ${TOOLS.length} tools ready (${config.name ?? 'default'}).`)
  })
  ctx.inject(['systemPrompt'], inner => {
    inner.effect(
      () => inner.systemPrompt.section({ name: 'dsh-fs-compact:tooling', order: 3252, interpolate: false, text: SECTION }),
      'dsh-fs-compact: tooling prompt',
    )
  })
}
