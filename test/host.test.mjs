/**
 * Host-side checks for the config transfer engine.
 *
 * These run without a Harness process: a temporary profile supplies the patch
 * file and a small fake context supplies the three services the engine reads.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseDocument } from 'yaml'
import {
  applyImport, applyItemToDocument, buildExport, collectPatchItems, readPatchDocument, sanitizeValue,
} from '../index.js'

const PATCH = `# personal profile
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
- id: llm-demo
  name: "@deepseek-ai/dsh-llm-demo"
  config:
    apiKeyEnv: DEMO_API_KEY
    apiKey: sk-live-example
    list:
      - name: keep
      - name: replace
- insert:
    - id: mcp-demo
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: demo
        transport: stdio
        command: node
        env:
          API_TOKEN: super-secret
          SAFE_VALUE: plain
    - id: preset-custom
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: custom
        name: Custom preset
        plugins: []
- id: tool-conditional
  name: "@example/tool-conditional"
  disabled: !!js process.env.TOOL_DISABLED === "1"
`

/** Create one temporary profile with the sample patch. */
async function profile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-config-transfer-'))
  await fsp.writeFile(path.join(dir, 'cordis.patch.yml'), PATCH, { mode: 0o600 })
  return dir
}

/** Minimal context around the temporary profile. */
function context(dir, overrides = {}) {
  const bundles = overrides.bundles ?? [{
    name: 'dsh-config-transfer', enabled: true, installed: true, official: false,
    availability: 'profile', version: '1.0.0', source: 'link:/tmp/dsh-config-transfer',
  }, {
    name: '@deepseek-ai/dsh-base', enabled: true, installed: false, official: true,
    availability: 'installation', version: '0.2.2-rc.3',
  }]
  const ctx = {
    profileContext: { dir, patchPath: path.join(dir, 'cordis.patch.yml') },
    pluginManager: {
      async listBundles() { return bundles },
      async listPlugins() { return overrides.plugins ?? [] },
      async setBundleEnabled() { return { application: 'applied' } },
      async installBundle() { return { application: 'applied' } },
    },
    configEditor: { entries() { return overrides.entries ?? [] } },
    get(name) { return this[name] },
  }
  return ctx
}

test('collects inserted, overriding and conditional rows into categories', async () => {
  const dir = await profile()
  const { doc } = await readPatchDocument(path.join(dir, 'cordis.patch.yml'))
  const collection = collectPatchItems(doc)
  assert.deepEqual(collection.order, ['ui-chat', 'llm-demo', 'mcp-demo', 'preset-custom', 'tool-conditional'])
  assert.equal(collection.map.get('mcp-demo').kind, 'insert')
  assert.equal(collection.map.get('ui-chat').kind, 'override')
  assert.equal(collection.map.get('tool-conditional').disabledExpr, 'process.env.TOOL_DISABLED === "1"')
})

test('exports categories, redacts credentials and keeps environment references', async () => {
  const dir = await profile()
  const ctx = context(dir)
  const document = await buildExport(ctx, ['bundles', 'plugins', 'mcp', 'presets'])
  assert.equal(document.format, 'dsh-config-transfer')
  assert.equal(document.version, 1)
  assert.deepEqual(document.categories.bundles.items.map(item => item.name), ['dsh-config-transfer'])

  const llm = document.categories.plugins.items.find(item => item.id === 'llm-demo')
  assert.equal(llm.config.apiKeyEnv, 'DEMO_API_KEY')
  assert.equal(llm.config.apiKey, '***REDACTED***')
  assert.deepEqual(llm.redacted, ['config.apiKey'])

  const mcp = document.categories.mcp.items.find(item => item.id === 'mcp-demo')
  assert.equal(mcp.config.env.API_TOKEN, '***REDACTED***')
  assert.equal(mcp.config.env.SAFE_VALUE, '***REDACTED***', 'every env value is treated as a credential container')
  assert.equal(document.categories.presets.items.find(item => item.id === 'preset-custom').config.name, 'Custom preset')

  const full = await buildExport(ctx, ['plugins', 'mcp'], { includeSecrets: true })
  assert.equal(full.secretsIncluded, true)
  assert.equal(full.categories.plugins.items.find(item => item.id === 'llm-demo').config.apiKey, 'sk-live-example')
  assert.equal(full.categories.mcp.items[0].config.env.API_TOKEN, 'super-secret')
})

test('updates existing rows, creates missing rows and keeps a backup', async () => {
  const dir = await profile()
  const ctx = context(dir)
  const document = {
    format: 'dsh-config-transfer',
    version: 1,
    categories: {
      plugins: {
        items: [
          { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', kind: 'override', config: { transcriptView: 'compact' } },
          { id: 'new-plugin', name: '@example/new-plugin', kind: 'insert', config: { enabled: true } },
          { id: 'llm-demo', kind: 'override', config: { apiKey: '***REDACTED***', apiKeyEnv: 'DEMO_API_KEY' } },
        ],
      },
      mcp: {
        items: [{ id: 'mcp-demo', kind: 'insert', config: { serverName: 'demo', transport: 'http', url: 'http://localhost' } }],
      },
    },
  }
  const report = await applyImport(ctx, document, ['plugins', 'mcp'], {})
  assert.equal(report.failed, 0, JSON.stringify(report.categories))
  assert.equal(report.applied, 4)
  assert.ok(report.backup && report.backup.includes('.bak-'))
  assert.ok((await fsp.stat(report.backup)).isFile())

  const text = await fsp.readFile(path.join(dir, 'cordis.patch.yml'), 'utf8')
  const doc = parseDocument(text)
  const rows = doc.toJS()
  const chat = rows.find(row => row.id === 'ui-chat')
  assert.equal(chat.config.transcriptView, 'compact')
  const llm = rows.find(row => row.id === 'llm-demo')
  assert.equal(llm.config.apiKey, 'sk-live-example', 'a redacted value must not overwrite the target secret')
  const inserted = rows.flatMap(row => row.insert ?? [])
  const created = inserted.find(row => row.id === 'new-plugin')
  assert.equal(created.name, '@example/new-plugin')
  assert.equal(inserted.find(row => row.id === 'mcp-demo').config.transport, 'http')
  assert.match(text, /personal profile/, 'comments outside edited values survive')
})

test('creates a conditional disabled expression as a Loader tag', async () => {
  const dir = await profile()
  const ctx = context(dir)
  const document = {
    format: 'dsh-config-transfer',
    version: 1,
    categories: {
      plugins: {
        items: [{ id: 'tool-conditional', kind: 'override', disabledExpr: 'process.env.OFF === "1"' }],
      },
    },
  }
  await applyImport(ctx, document, ['plugins'], {})
  const text = await fsp.readFile(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /!!js process\.env\.OFF === "1"/)
})

test('refuses a foreign or oversized document', async () => {
  const dir = await profile()
  const ctx = context(dir)
  await assert.rejects(
    () => applyImport(ctx, { format: 'something-else', version: 1, categories: {} }, ['plugins'], {}),
    /not a dsh-config-transfer document/,
  )
  await assert.rejects(
    () => applyImport(ctx, { format: 'dsh-config-transfer', version: 2, categories: {} }, ['plugins'], {}),
    /unsupported document version/,
  )
})

test('direct row updates insert a new top-level insert block when needed', () => {
  const doc = parseDocument('[]\n')
  doc.contents.flow = false
  assert.equal(applyItemToDocument(doc, {
    id: 'fresh', name: '@example/fresh', kind: 'insert', config: { a: 1 }, disabled: false, group: true,
  }), 'inserted')
  const rows = doc.toJS()
  assert.equal(rows[0].insert[0].id, 'fresh')
  assert.equal(rows[0].insert[0].config.a, 1)
  assert.equal(rows[0].insert[0].disabled, false)
})

test('writes an id-only override when a bundle row has no module name in the document', () => {
  const doc = parseDocument('[]\n')
  doc.contents.flow = false
  assert.equal(applyItemToDocument(doc, {
    id: 'ui-chat', kind: 'override', config: { transcriptView: 'compact' }, disabled: true,
  }), 'updated')
  const row = doc.toJS()[0]
  assert.equal(row.id, 'ui-chat')
  assert.equal(row.config.transcriptView, 'compact')
  assert.equal(row.disabled, true)
  assert.equal(row.insert, undefined)
  assert.throws(() => applyItemToDocument(parseDocument('[]\n'), { id: 'new', kind: 'insert' }), /no module name/)
})

test('keeps target array elements behind redacted placeholders', async () => {
  const dir = await profile()
  const ctx = context(dir)
  await applyImport(ctx, {
    format: 'dsh-config-transfer',
    version: 1,
    categories: {
      plugins: {
        items: [{
          id: 'llm-demo', kind: 'override',
          config: { list: ['***REDACTED***', 'replaced'] },
        }],
      },
    },
  }, ['plugins'], {})
  const text = await fsp.readFile(path.join(dir, 'cordis.patch.yml'), 'utf8')
  const rows = parseDocument(text).toJS()
  assert.deepEqual(rows.find(row => row.id === 'llm-demo').config.list, [{ name: 'keep' }, 'replaced'])
  assert.equal(text.includes('sk-live-example'), true, 'unrelated configuration survives the merge')
})

test('redacts credentials inside env containers even with a generic key', () => {
  const redacted = []
  const source = { env: { PRIVATE_KEY: 'abc', SIGNING_KEY: 'def', REF: '${TOKEN}' } }
  const safe = sanitizeValue(source, '', [], redacted, false)
  assert.equal(safe.env.PRIVATE_KEY, '***REDACTED***')
  assert.equal(safe.env.SIGNING_KEY, '***REDACTED***')
  assert.equal(safe.env.REF, '${TOKEN}')
  assert.equal(redacted.length, 2)
})

test('sanitizes nested values without mutating the source', () => {
  const redacted = []
  const source = { headers: { Authorization: 'Bearer abc' }, env: { TOKEN: 'abc', URL: 'https://x' }, list: [{ secret: 'abc' }] }
  const safe = sanitizeValue(source, '', [], redacted, false)
  assert.equal(safe.headers.Authorization, '***REDACTED***')
  assert.equal(safe.env.TOKEN, '***REDACTED***')
  assert.equal(safe.env.URL, '***REDACTED***')
  assert.equal(safe.list[0].secret, '***REDACTED***')
  assert.equal(source.headers.Authorization, 'Bearer abc')
  assert.equal(redacted.length, 4)
})
