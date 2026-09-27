/**
 * File references in model text: ``src/app.ts:42``, ``src/app.ts:42:7`` and
 * ``src/app.ts#L42`` in code spans, link targets, and tool output.
 *
 * Recognition is deliberately conservative, because a false positive turns
 * code into a link that goes nowhere: free text needs a folder or a line
 * number, and a bare name in a code span needs a known extension, so
 * ``config.enabled`` and ``e.g.`` stay text.
 */

export interface FileRef {
  path: string
  line?: number
  column?: number
}

/** Extensions that make a bare name (no folder) a file. */
const KNOWN_EXTENSIONS = new Set([
  'astro', 'bash', 'c', 'cc', 'cfg', 'cjs', 'clj', 'cmake', 'conf', 'cpp', 'cs', 'css', 'csv', 'dart',
  'dockerfile', 'env', 'erl', 'ex', 'exs', 'fish', 'gql', 'go', 'gradle', 'graphql', 'h', 'hcl', 'hpp',
  'hs', 'htm', 'html', 'ini', 'java', 'jl', 'js', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'lock',
  'log', 'lua', 'md', 'mdx', 'mjs', 'mk', 'ml', 'nim', 'nix', 'php', 'plist', 'proto', 'ps1', 'py', 'pyi',
  'rb', 'rs', 'sass', 'scala', 'scss', 'sh', 'sql', 'svelte', 'svg', 'swift', 'tf', 'toml', 'ts', 'tsv',
  'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zig', 'zsh',
])

/** Free text is capped so a huge log cannot mint thousands of links. */
const MAX_FREE_REFS = 500

// A segment never ends on a dot, so "see src/a.ts." leaves the full stop out.
const SEGMENT = String.raw`[\w@+-](?:[\w.@+-]*[\w@+-])?`
const PATH = String.raw`(?:\.{1,2}\/|~\/|\/)?(?:${SEGMENT}\/)*${SEGMENT}`
// :line[:column], or a GitHub anchor #Lline[Ccolumn][-Lend].
const POSITION = String.raw`(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)`
const EXACT = new RegExp(`^(${PATH})${POSITION}?$`)
const FREE = new RegExp(String.raw`(?<![\w./@~:-])(${PATH})${POSITION}?(?![\w/])`, 'g')
const HREF = new RegExp(`^(.+?)${POSITION}?$`)

function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(name)?.[1].toLowerCase() ?? null
}

function withPosition(path: string, match: RegExpExecArray | RegExpMatchArray, offset: number): FileRef | null {
  const line = match[offset] ?? match[offset + 2]
  const column = match[offset + 1] ?? match[offset + 3]
  if (line === undefined) return { path }
  if (Number(line) < 1) return null
  return column === undefined ? { path, line: Number(line) } : { path, line: Number(line), column: Number(column) }
}

/** A code span that is nothing but a file reference. */
export function parseFileRef(text: string): FileRef | null {
  const match = EXACT.exec(text.trim())
  if (!match) return null
  const path = match[1]
  const extension = extensionOf(path)
  if (!extension || (!path.includes('/') && !KNOWN_EXTENSIONS.has(extension))) return null
  return withPosition(path, match, 2)
}

/** A Markdown link target that names a workspace file rather than a page. */
export function parseFileHref(href: string): FileRef | null {
  const raw = href.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || raw.includes('?')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  let decoded: string
  try {
    decoded = decodeURI(raw)
  } catch {
    return null
  }
  const match = HREF.exec(decoded)
  if (!match || match[1].endsWith('/') || /[#:]/.test(match[1])) return null
  return withPosition(match[1], match, 2)
}

/** File references in free text, e.g. compiler or grep output, in order. */
export function findFileRefs(text: string): Array<{ start: number; end: number; ref: FileRef }> {
  const found: Array<{ start: number; end: number; ref: FileRef }> = []
  for (const match of text.matchAll(FREE)) {
    const path = match[1]
    const hasLine = match[2] !== undefined || match[4] !== undefined
    if (!extensionOf(path) || (!path.includes('/') && !hasLine)) continue
    const ref = withPosition(path, match, 2)
    if (!ref) continue
    const start = match.index ?? 0
    found.push({ start, end: start + match[0].length, ref })
    if (found.length >= MAX_FREE_REFS) break
  }
  return found
}

/** ``path`` relative to ``workspace``, or ``null`` when it points outside it. */
export function workspaceRelativePath(path: string, workspace: string | null): string | null {
  if (path.startsWith('~')) return null
  let relative = path
  if (relative.startsWith('/')) {
    const root = workspace?.replace(/\/+$/, '')
    if (!root || !relative.startsWith(`${root}/`)) return null
    relative = relative.slice(root.length + 1)
  }
  const parts: string[] = []
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length > 0 ? parts.join('/') : null
}
