/**
 * Host half of the config transfer bundle.
 *
 * The browser half owns the Settings page: category checkboxes, the download,
 * and the file picker. This half owns the two operations the browser cannot
 * perform on its own:
 *
 * - reading the active profile's real configuration layers
 *   (`cordis.patch.yml`, the ordered `dsh.profile.bundles` selection and the
 *   installed bundle inventory) and shaping one versioned JSON document;
 * - applying a chosen part of such a document back to the profile through the
 *   same files the Plugin Manager and the built-in Settings pages write.
 *
 * Nothing here activates an Agent or touches the Session store. Profile
 * configuration is the only state that is read or written.
 *
 * Patch rows are edited as YAML nodes, so comments and `!!js` expressions
 * outside a replaced value survive. Every import writes a timestamped backup
 * before the first change, and refuses to proceed when the document is not a
 * `dsh-config-transfer` v1 document.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Scalar, isMap, isSeq, parseDocument, visit } from 'yaml'

/** Document identifier written to and required from an exported file. */
const FORMAT = 'dsh-config-transfer'

/** The only document version this build understands. */
const FORMAT_VERSION = 1

/** Category ids understood by both halves, in display order. */
export const CATEGORIES = ['bundles', 'plugins', 'mcp', 'presets']

/** Bundles the profile template always selects; restoring them is noise. */
const ESSENTIAL_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

/** Module name that marks an MCP server row. */
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Module name that marks an agent-preset declaration row. */
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'

/** Route family served to this bundle's browser half. */
const ROUTE_BASE = '/api/dsh-config-transfer'

/** Placeholder that replaces a value the export did not include. */
const REDACTED = '***REDACTED***'

/** JSON marker carrying one Loader `!!js` expression. */
const JS_MARKER = '__dshConfigTransferJs'

/** Rejected request bodies above this size. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Items accepted per category in one document. */
const MAX_ITEMS = 1000

/** YAML parse options that keep Loader JavaScript expressions addressable. */
const PATCH_PARSE_OPTIONS = {
  customTags: [{
    tag: 'tag:yaml.org,2002:js',
    resolve: value => ({ [JS_MARKER]: String(value) }),
  }],
}

/** The Host services used before the routes can answer. */
export const inject = ['connection']

/**
 * Register the inventory, export and import routes.
 * @param ctx - Host context carrying `connection`.
 * @param _config - this row's config (unused).
 */
export function apply(ctx, _config) {
  const connection = readService(ctx, 'connection')
  const register = connection?.fetch && typeof connection.fetch.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
  if (register === undefined) {
    ctx.logger?.warn?.('config-transfer: the Host connection service exposes no fetch route registry')
    return
  }

  const route = (name, methods, handler) => ctx.effect(() => register({
    path: `${ROUTE_BASE}.${name}`,
    methods,
    requestBody: 'buffered',
    fetch: request => guard(handler, request),
  }), `config-transfer: ${name} route`)

  route('inventory', ['GET'], async () => json(await buildInventory(ctx), 200))
  route('export', ['POST'], async (request) => {
    const body = await readJson(request)
    const categories = normalizeCategoryList(body?.categories)
    const document = await buildExport(ctx, categories, { includeSecrets: body?.includeSecrets === true })
    return json({ ok: true, document }, 200)
  })
  route('import', ['POST'], async (request) => {
    const body = await readJson(request)
    if (!isPlainObject(body) || body.document === undefined) throw new HttpError(400, 'missing document')
    const categories = normalizeCategoryList(body.categories)
    const report = await applyImport(ctx, body.document, categories, {
      installMissingBundles: body?.options?.installMissingBundles === true,
    })
    return json(report, 200)
  })
}

/**
 * Read everything the Settings page shows before a transfer.
 * @param ctx - Host context.
 * @returns profile facts and one summary per category.
 */
export async function buildInventory(ctx) {
  const profile = requireProfile(ctx)
  const warnings = []
  const [moduleById, bundles] = await Promise.all([moduleNameById(ctx), listBundles(ctx, warnings)])
  const { doc } = await readPatchDocument(profile.patchPath)
  const collection = collectPatchItems(doc, moduleById)
  const groups = groupItems(collection)

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dshVersion: await readDshVersion(),
    profile: {
      name: profile.name,
      dir: profile.dir,
      patchPath: profile.patchPath,
    },
    capabilities: {
      bundles: bundles.length > 0 || warnings.length === 0,
      config: true,
    },
    categories: CATEGORIES.map((id) => {
      if (id === 'bundles') {
        return {
          id,
          count: bundles.length,
          items: bundles.map(bundleSummary),
          warning: warnings.find(warning => warning.startsWith('bundles:'))?.slice('bundles:'.length).trim(),
        }
      }
      const entries = groups.get(id) ?? []
      return {
        id,
        count: entries.length,
        items: entries.map(entrySummary),
      }
    }),
    warnings,
  }
}

/**
 * Build one export document from the chosen categories.
 * @param ctx - Host context.
 * @param categories - category ids to include.
 * @param options - `includeSecrets` keeps credential values instead of REDACTED.
 * @returns the versioned transfer document.
 */
export async function buildExport(ctx, categories, options = {}) {
  const profile = requireProfile(ctx)
  const selected = categories.length > 0 ? categories : CATEGORIES
  const includeSecrets = options.includeSecrets === true
  const warnings = []
  const [moduleById, bundles] = await Promise.all([moduleNameById(ctx), listBundles(ctx, warnings)])
  const { doc } = await readPatchDocument(profile.patchPath)
  const collection = collectPatchItems(doc, moduleById)
  const groups = groupItems(collection)

  const document = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      profile: profile.name,
      dshVersion: await readDshVersion(),
      platform: process.platform,
      arch: process.arch,
    },
    secretsIncluded: includeSecrets,
    categories: {},
  }

  for (const id of selected) {
    if (id === 'bundles') {
      document.categories.bundles = {
        items: bundles.map((bundle) => {
          const item = {
            name: bundle.name,
            enabled: bundle.enabled === true,
            installed: bundle.installed === true,
            official: bundle.official === true,
            availability: bundle.availability,
          }
          if (typeof bundle.version === 'string') item.version = bundle.version
          if (typeof bundle.source === 'string') item.source = bundle.source
          if (isPlainObject(bundle.installTarget) && typeof bundle.installTarget.spec === 'string') {
            item.installTarget = {
              spec: bundle.installTarget.spec,
              ...typeof bundle.installTarget.version === 'string' ? { version: bundle.installTarget.version } : {},
            }
          }
          if (typeof bundle.description === 'string' && bundle.description.length > 0) item.description = bundle.description
          return item
        }),
      }
      continue
    }

    const entries = groups.get(id) ?? []
    document.categories[id] = {
      items: entries.map((item) => {
        const out = { id: item.id, kind: item.kind }
        if (typeof item.name === 'string') out.name = item.name
        if (typeof item.module === 'string' && item.module !== item.name) out.module = item.module
        if (item.config !== undefined) {
          const redacted = []
          out.config = sanitizeValue(item.config, '', ['config'], redacted, includeSecrets)
          if (redacted.length > 0) out.redacted = redacted
        }
        if (item.disabled !== undefined) out.disabled = item.disabled
        if (typeof item.disabledExpr === 'string') out.disabledExpr = item.disabledExpr
        if (item.group === true) out.group = true
        return out
      }),
    }
  }

  if (warnings.length > 0) document.warnings = warnings
  return document
}

/**
 * Apply a transfer document to the active profile.
 * @param ctx - Host context.
 * @param input - parsed document from the browser.
 * @param categories - category ids the user chose to import.
 * @param options - `installMissingBundles` permits package installation.
 * @returns a per-category report.
 */
export async function applyImport(ctx, input, categories, options = {}) {
  const profile = requireProfile(ctx)
  const document = normalizeDocument(input)
  const available = new Set(Object.keys(document.categories))
  const selected = categories.filter(id => available.has(id))
  if (selected.length === 0) throw new HttpError(400, 'the document contains none of the selected categories')

  const report = {
    ok: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    applied: 0,
    skipped: 0,
    failed: 0,
    restartRequired: false,
    backup: null,
    categories: { bundles: [], plugins: [], mcp: [], presets: [] },
    warnings: [],
  }

  if (selected.includes('bundles')) {
    await importBundles(ctx, document.categories.bundles.items, options, report)
  }

  const entryCategories = selected.filter(id => id !== 'bundles')
  if (entryCategories.length > 0) {
    report.backup = await backupPatch(profile.patchPath)
    await importEntries(ctx, document, entryCategories, report)
  }

  const hmr = readService(ctx, 'hmr')
  if (hmr === undefined) {
    report.restartRequired = true
  } else if (report.applied > 0) {
    // HMR watches the profile patch and recomposes after its settle window.
    await sleep(3200)
  }

  try {
    const after = await listPlugins(ctx)
    for (const id of report.changedIds ?? []) {
      const entry = after.find(plugin => plugin?.patchId === id)
      if (typeof entry?.diagnostic === 'string' && entry.diagnostic.length > 0) {
        report.warnings.push(`${id}: ${entry.diagnostic}`)
      }
    }
  } catch { /* diagnostics are best-effort */ }
  delete report.changedIds

  report.finishedAt = new Date().toISOString()
  report.ok = report.failed === 0
  return report
}

/**
 * Import the bundle category.
 * @param ctx - Host context.
 * @param items - normalized bundle items.
 * @param options - import options.
 * @param report - the shared report.
 */
async function importBundles(ctx, items, options, report) {
  const manager = readService(ctx, 'pluginManager')
  if (manager === undefined || typeof manager.listBundles !== 'function') {
    for (const item of items) record(report, 'bundles', item.name, 'failed', 'the plugin manager service is unavailable')
    return
  }

  let current
  try {
    current = await manager.listBundles()
  } catch (error) {
    for (const item of items) record(report, 'bundles', item.name, 'failed', messageOf(error))
    return
  }
  const byName = new Map(current.map(bundle => [bundle.name, bundle]))
  const ordered = [
    ...items.filter(item => item.enabled === false),
    ...items.filter(item => item.enabled === true),
  ]

  for (const item of ordered) {
    try {
      const bundle = byName.get(item.name)
      if (item.enabled === false) {
        if (bundle?.enabled !== true) {
          record(report, 'bundles', item.name, 'skipped', 'already off')
          continue
        }
        const result = await manager.setBundleEnabled(item.name, false)
        recordChange(report, 'bundles', item.name, result, 'turned off')
        continue
      }

      if (bundle?.enabled === true) {
        record(report, 'bundles', item.name, 'skipped', 'already on')
        continue
      }

      const available = bundle !== undefined && bundle.availability !== 'missing' && bundle.error === undefined
      if (available) {
        const result = await manager.setBundleEnabled(item.name, true)
        recordChange(report, 'bundles', item.name, result, 'turned on')
        continue
      }

      if (options.installMissingBundles !== true) {
        const spec = installSpecOf(item)
        record(report, 'bundles', item.name, 'skipped',
          spec === null ? 'not installed; no source recorded' : `not installed; install from ${spec}`)
        continue
      }

      const spec = installSpecOf(item)
      if (spec === null) {
        record(report, 'bundles', item.name, 'failed', 'not installed and no install source is recorded')
        continue
      }
      if (await isMissingLocalSpec(spec)) {
        record(report, 'bundles', item.name, 'failed', `the recorded local path does not exist: ${spec}`)
        continue
      }

      const result = await manager.installBundle(spec, { enabled: true })
      recordChange(report, 'bundles', item.name, result, 'installed')
    } catch (error) {
      record(report, 'bundles', item.name, 'failed', messageOf(error))
    }
  }
}

/**
 * Import plugin configuration, MCP servers and agent presets.
 * @param ctx - Host context.
 * @param document - normalized transfer document.
 * @param categories - entry categories to import.
 * @param report - the shared report.
 */
async function importEntries(ctx, document, categories, report) {
  const editor = readService(ctx, 'configEditor')
  const entries = () => {
    if (editor === undefined || typeof editor.entries !== 'function') return new Map()
    try {
      return new Map(editor.entries().map(entry => [entry?.options?.id, entry]))
    } catch {
      return new Map()
    }
  }
  const info = new Map((await listPlugins(ctx)).map(plugin => [plugin?.patchId, plugin]))
  const direct = []

  // Prefer the validated editor path for live, enabled rows. It writes the
  // complete override through the normal Loader lifecycle, so a schema
  // mismatch is reported instead of corrupting the composition.
  for (const category of categories) {
    for (const item of document.categories[category].items) {
      const live = info.get(item.id)
      const disabledChanges = item.disabled !== undefined && item.disabled !== live?.enabled
      const entry = entries().get(item.id)
      const editable = item.config !== undefined
        && entry !== undefined
        && entry.fiber !== undefined
        && entry.options?.disabled !== true
        && !disabledChanges
        && item.group !== true
        && !containsJsMarker(item.config)
      if (!editable) {
        // A live row already exists in another layer: amend it instead of
        // inserting a second row with the same id.
        direct.push({ category, item: item.kind === 'insert' && info.has(item.id) ? { ...item, kind: 'override' } : item })
        continue
      }
      try {
        await editor.edit(entry, current => mergeConfig(current, item.config))
        record(report, category, item.id, 'applied', 'configuration updated')
        report.changedIds ??= []
        report.changedIds.push(item.id)
      } catch (error) {
        record(report, category, item.id, 'failed', messageOf(error))
      }
    }
  }

  if (direct.length > 0) {
    let changed = false
    const { doc } = await readPatchDocument(requireProfile(ctx).patchPath)
    for (const { category, item } of direct) {
      try {
        const outcome = applyItemToDocument(doc, item)
        changed = changed || outcome !== 'unchanged'
        record(report, category, item.id, outcome === 'unchanged' ? 'skipped' : 'applied',
          outcome === 'inserted' ? 'row created' : outcome === 'updated' ? 'configuration updated' : 'no change')
        if (outcome !== 'unchanged') {
          report.changedIds ??= []
          report.changedIds.push(item.id)
        }
      } catch (error) {
        record(report, category, item.id, 'failed', messageOf(error))
      }
    }
    if (changed) await writePatchDocument(requireProfile(ctx).patchPath, doc)
  }
}

/**
 * Mutate one parsed patch document with one normalized entry item.
 * @param doc - parsed YAML document (a top-level sequence).
 * @param item - normalized entry item.
 * @returns 'inserted', 'updated' or 'unchanged'.
 */
export function applyItemToDocument(doc, item) {
  if (!isSeq(doc.contents)) throw new Error('profile patch must be a YAML sequence')

  const overrideIndex = findOverrideIndex(doc, item.id)
  if (overrideIndex >= 0) {
    const node = doc.contents.items[overrideIndex]
    return updateRowNode(doc, node, item, false)
  }

  const inserted = findInsertedRow(doc, item.id)
  if (inserted !== undefined) {
    return updateRowNode(doc, inserted.node, item, true)
  }

  if (item.kind !== 'insert') {
    // An override targets a row another layer supplies (a bundle row, usually);
    // it needs only the id and stays inert when that row never appears.
    const row = { id: item.id }
    if (typeof item.name === 'string' && item.name.length > 0) row.name = item.name
    if (item.config !== undefined) row.config = stripRedacted(item.config)
    if (item.disabled !== undefined) row.disabled = item.disabled
    doc.contents.add(doc.createNode(row))
    const added = doc.contents.items[doc.contents.items.length - 1]
    applyDisabledExpression(added, item)
    return 'updated'
  }

  if (typeof item.name !== 'string' || item.name.length === 0) {
    throw new Error(`row "${item.id}" is absent and the document carries no module name to create it`)
  }

  const row = { id: item.id, name: item.name }
  if (item.config !== undefined) row.config = stripRedacted(item.config)
  if (item.disabled !== undefined) row.disabled = item.disabled
  if (item.group === true) row.group = true

  const sequence = lastInsertSequence(doc)
  if (sequence !== undefined) {
    const node = doc.createNode(row)
    sequence.add(node)
    applyDisabledExpression(node, item)
  } else {
    doc.contents.add(doc.createNode({ insert: [row] }))
    const added = doc.contents.items[doc.contents.items.length - 1]
    const sequence = isMap(added) ? added.get('insert') : undefined
    if (isSeq(sequence) && sequence.items.length > 0) applyDisabledExpression(sequence.items[0], item)
  }
  return 'inserted'
}

/**
 * Apply config, enablement and expression fields to one existing row node.
 * @param doc - owning document.
 * @param node - row mapping node.
 * @param item - normalized item.
 * @param inserted - whether this is a bundle-inserted row child.
 * @returns 'updated' or 'unchanged'.
 */
function updateRowNode(doc, node, item, inserted) {
  if (!isMap(node)) throw new Error(`row "${item.id}" is not a mapping`)
  let changed = false
  if (inserted && !node.has('name') && typeof item.name === 'string') {
    node.set('name', item.name)
    changed = true
  }
  if (item.config !== undefined) {
    const current = nodeValue(node, 'config')
    const merged = isPlainObject(current) ? mergeConfig(current, item.config) : stripRedacted(item.config)
    node.set('config', doc.createNode(merged))
    changed = true
  }
  if (item.disabled !== undefined) {
    if (!node.has('disabled') || node.get('disabled') !== item.disabled) {
      node.set('disabled', item.disabled)
      changed = true
    }
  }
  if (applyDisabledExpression(node, item)) changed = true
  if (item.group === true && node.get('group') !== true) {
    node.set('group', true)
    changed = true
  }
  return changed ? 'updated' : 'unchanged'
}

/** Apply a JavaScript disabled expression to a row node. @returns whether it changed. */
function applyDisabledExpression(node, item) {
  if (!isMap(node) || typeof item.disabledExpr !== 'string') return false
  if (item.disabled !== undefined) return false
  node.set('disabled', jsScalar(item.disabledExpr))
  return true
}

/**
 * Read the profile patch as a YAML document.
 * @param patchPath - absolute profile patch path.
 * @returns the document and its source text.
 */
export async function readPatchDocument(patchPath) {
  let text
  try {
    text = await fsp.readFile(patchPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    text = '[]\n'
  }
  if (text.trim().length === 0) text = '[]\n'
  const doc = parseDocument(text, PATCH_PARSE_OPTIONS)
  if (doc.errors.length > 0) throw new Error(`the profile patch is not valid YAML: ${doc.errors[0].message}`)
  if (!isSeq(doc.contents)) throw new Error('the profile patch must be a YAML sequence')
  doc.contents.flow = false
  return { doc, text }
}

/**
 * Serialize a parsed patch, restoring Loader `!!js` tags.
 * @param doc - parsed document.
 * @returns YAML source.
 */
export function serializePatch(doc) {
  doc.contents.flow = false
  visit(doc, {
    Map(_key, node) {
      if (node.items.length !== 1) return undefined
      const value = node.get(JS_MARKER)
      if (typeof value !== 'string') return undefined
      return jsScalar(value)
    },
  })
  return String(doc)
}

/**
 * Collect every profile patch row into one effective item per id.
 * @param doc - parsed patch document.
 * @param moduleById - live entry id to module-name map.
 * @returns ordered ids and an id map.
 */
export function collectPatchItems(doc, moduleById = new Map()) {
  const map = new Map()
  const order = []
  const rows = doc.toJS()
  if (!Array.isArray(rows)) return { map, order }

  const add = (row, kind) => {
    if (!isPlainObject(row) || typeof row.id !== 'string' || row.id.length === 0) return
    let item = map.get(row.id)
    if (item === undefined) {
      item = { id: row.id, kind }
      map.set(row.id, item)
      order.push(row.id)
    }
    if (kind === 'insert') item.kind = 'insert'
    if (typeof row.name === 'string' && row.name.length > 0) item.name = row.name
    if (Object.hasOwn(row, 'config')) item.config = row.config
    if (Object.hasOwn(row, 'disabled')) {
      if (typeof row.disabled === 'boolean') {
        item.disabled = row.disabled
        delete item.disabledExpr
      } else if (isJsMarker(row.disabled)) {
        item.disabledExpr = row.disabled[JS_MARKER]
        delete item.disabled
      }
    }
    if (row.group === true) item.group = true
  }

  for (const row of rows) {
    if (!isPlainObject(row)) continue
    if (Array.isArray(row.insert)) {
      for (const child of row.insert) add(child, 'insert')
    } else if (typeof row.id === 'string') {
      add(row, 'override')
    }
  }

  for (const item of map.values()) {
    item.module = item.name ?? moduleById.get(item.id)
  }
  return { map, order }
}

/**
 * Group collected items into transfer categories.
 * @param collection - result of `collectPatchItems`.
 * @returns a map from category id to ordered items.
 */
function groupItems(collection) {
  const groups = new Map(CATEGORIES.filter(id => id !== 'bundles').map(id => [id, []]))
  for (const id of collection.order) {
    const item = collection.map.get(id)
    if (item === undefined) continue
    const module = item.module
    const category = module === MCP_MODULE ? 'mcp' : module === PRESET_MODULE ? 'presets' : 'plugins'
    groups.get(category).push(item)
  }
  return groups
}

/** Summarize one patch item for the Settings inventory. */
function entrySummary(item) {
  const out = {
    id: item.id,
    kind: item.kind,
    label: item.id,
    module: item.module,
  }
  if (item.disabled === true) out.disabled = true
  if (item.disabledExpr !== undefined) out.conditional = true
  if (item.config !== undefined) {
    out.hasConfig = true
    out.configKeys = isPlainObject(item.config) ? Object.keys(item.config).length : 0
  }
  if (item.module === MCP_MODULE) {
    const server = isPlainObject(item.config) ? item.config.serverName : undefined
    out.label = typeof server === 'string' && server.length > 0 ? server : item.id
    out.detail = isPlainObject(item.config) && typeof item.config.transport === 'string' ? item.config.transport : undefined
  } else if (item.module === PRESET_MODULE) {
    const config = isPlainObject(item.config) ? item.config : {}
    out.label = typeof config.name === 'string' && config.name.length > 0
      ? config.name
      : typeof config.id === 'string' && config.id.length > 0 ? config.id : item.id
  } else if (typeof item.name === 'string') {
    out.label = item.id
  }
  return out
}

/** Summarize one bundle for the Settings inventory. */
function bundleSummary(bundle) {
  return {
    name: bundle.name,
    enabled: bundle.enabled === true,
    installed: bundle.installed === true,
    official: bundle.official === true,
    availability: bundle.availability,
    version: bundle.version,
    source: bundle.source,
  }
}

/** Read installed bundles, collecting a category-level warning on failure. */
async function listBundles(ctx, warnings) {
  const manager = readService(ctx, 'pluginManager')
  if (manager === undefined || typeof manager.listBundles !== 'function') {
    warnings?.push('bundles: the plugin manager service is unavailable')
    return []
  }
  try {
    const all = await manager.listBundles()
    return all.filter(bundle => (bundle?.installed === true || bundle?.enabled === true)
      && !ESSENTIAL_BUNDLES.has(bundle.name))
  } catch (error) {
    warnings?.push(`bundles: ${messageOf(error)}`)
    return []
  }
}

/** Read the live plugin inventory without failing the caller. */
async function listPlugins(ctx) {
  const manager = readService(ctx, 'pluginManager')
  if (manager === undefined || typeof manager.listPlugins !== 'function') return []
  try { return await manager.listPlugins() } catch { return [] }
}

/** Read the id-to-module-name map from live entries and the plugin inventory. */
async function moduleNameById(ctx) {
  const map = new Map()
  const editor = readService(ctx, 'configEditor')
  if (editor !== undefined && typeof editor.entries === 'function') {
    try {
      for (const entry of editor.entries()) {
        const id = entry?.options?.id
        const name = entry?.options?.name
        if (typeof id === 'string' && typeof name === 'string') map.set(id, name)
      }
    } catch { /* unavailable inventory is not fatal */ }
  }
  for (const plugin of await listPlugins(ctx)) {
    if (typeof plugin?.patchId === 'string' && typeof plugin?.moduleName === 'string') {
      map.set(plugin.patchId, plugin.moduleName)
    }
  }
  return map
}

/** Validate and detach one import document. */
function normalizeDocument(input) {
  if (!isPlainObject(input)) throw new HttpError(400, 'the document must be a JSON object')
  if (input.format !== FORMAT) throw new HttpError(400, 'this is not a dsh-config-transfer document')
  if (input.version !== FORMAT_VERSION) throw new HttpError(400, `unsupported document version ${String(input.version)}`)
  if (!isPlainObject(input.categories)) throw new HttpError(400, 'the document has no categories')

  const categories = {}
  for (const id of CATEGORIES) {
    const group = input.categories[id]
    if (group === undefined) continue
    if (!isPlainObject(group) || !Array.isArray(group.items)) throw new HttpError(400, `category ${id} has no items array`)
    if (group.items.length > MAX_ITEMS) throw new HttpError(400, `category ${id} has too many items`)
    categories[id] = {
      items: group.items.map(item => id === 'bundles' ? normalizeBundleItem(item) : normalizeEntryItem(item)),
    }
  }
  if (Object.keys(categories).length === 0) throw new HttpError(400, 'the document contains no categories')
  return { ...input, categories }
}

/** Validate one bundle item. */
function normalizeBundleItem(input) {
  if (!isPlainObject(input)) throw new HttpError(400, 'each bundle item must be an object')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > 300) throw new HttpError(400, 'a bundle item needs a package name')
  const item = { name, enabled: input.enabled === true }
  if (typeof input.installed === 'boolean') item.installed = input.installed
  if (typeof input.official === 'boolean') item.official = input.official
  if (typeof input.source === 'string') item.source = input.source
  if (typeof input.version === 'string') item.version = input.version
  if (isPlainObject(input.installTarget) && typeof input.installTarget.spec === 'string') {
    item.installTarget = { spec: input.installTarget.spec }
    if (typeof input.installTarget.version === 'string') item.installTarget.version = input.installTarget.version
  }
  return item
}

/** Validate one plugin, MCP or preset item. */
function normalizeEntryItem(input) {
  if (!isPlainObject(input)) throw new HttpError(400, 'each entry item must be an object')
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id.length === 0 || id.length > 200) throw new HttpError(400, 'an entry item needs an id')
  const item = { id }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 300) {
      throw new HttpError(400, `entry ${id} has an invalid module name`)
    }
    item.name = input.name
  }
  item.kind = input.kind === 'insert' ? 'insert' : 'override'
  if (input.config !== undefined) item.config = assertJsonValue(input.config, 0)
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== 'boolean') throw new HttpError(400, `entry ${id} has a non-boolean disabled value`)
    item.disabled = input.disabled
  }
  if (input.disabledExpr !== undefined) {
    if (typeof input.disabledExpr !== 'string') throw new HttpError(400, `entry ${id} has an invalid disabled expression`)
    item.disabledExpr = input.disabledExpr
  }
  if (input.group === true) item.group = true
  return item
}

/** Deep-clone a JSON-safe value, rejecting functions and reserved keys. */
function assertJsonValue(value, depth) {
  if (depth > 24) throw new HttpError(400, 'configuration is nested too deeply')
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 1_000_000) throw new HttpError(400, 'a configuration string is too long')
    return value
  }
  if (Array.isArray(value)) return value.map(entry => assertJsonValue(entry, depth + 1))
  if (!isPlainObject(value)) throw new HttpError(400, 'configuration must be JSON data')
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    out[key] = assertJsonValue(entry, depth + 1)
  }
  return out
}

/** Recursively replace credential-looking values with a sentinel. */
export function sanitizeValue(value, key, pathParts, redacted, includeSecrets, forced = false) {
  if (isJsMarker(value)) return { [JS_MARKER]: value[JS_MARKER] }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, key, [...pathParts, String(index)], redacted, includeSecrets, forced))
  }
  if (isPlainObject(value)) {
    const out = {}
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === '__proto__' || childKey === 'constructor' || childKey === 'prototype') continue
      // Everything under env/headers is a value a server or process would
      // consume as a credential even when its own key name is generic.
      const nested = forced || isCredentialContainer(childKey)
      out[childKey] = sanitizeValue(child, childKey, [...pathParts, childKey], redacted, includeSecrets, nested)
    }
    return out
  }
  if (!includeSecrets && typeof value === 'string'
    && (forced || isSecretKey(key) || looksLikeCredential(value))
    && !isCredentialReference(value)) {
    redacted.push(pathParts.join('.'))
    return REDACTED
  }
  return value
}

/** Whether a field holds a map of credentials rather than one credential. */
function isCredentialContainer(key) {
  if (typeof key !== 'string') return false
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  return normalized === 'env' || normalized === 'environment' || normalized === 'headers'
}

/** Whether a free-form string names a well-known credential format. */
function looksLikeCredential(value) {
  return /^(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|xox[abp]-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.)/.test(value)
}

/** Whether a field name names a credential rather than a reference to one. */
function isSecretKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
  if (normalized.endsWith('-env') || normalized === 'env' || normalized.endsWith('-env-var')) return false
  const parts = normalized.split('-')
  return parts.some(part => ['token', 'secret', 'password', 'passwd', 'apikey', 'authorization', 'cookie', 'credential', 'credentials', 'bearer'].includes(part))
    || normalized.includes('api-key')
}

/** Whether a value points at a credential instead of containing it. */
function isCredentialReference(value) {
  return /^\$\{[^}]+\}$/.test(value)
    || /^[A-Z][A-Z0-9_]{2,}$/.test(value)
    || /^(?:env|secret|credential|vault):/i.test(value)
}

/** Merge imported configuration into the target configuration. */
function mergeConfig(base, incoming) {
  if (Array.isArray(incoming)) {
    if (!Array.isArray(base)) return stripRedacted(incoming)
    const out = []
    incoming.forEach((value, index) => {
      if (value === REDACTED) {
        if (index < base.length) out.push(cloneJson(base[index]))
        return
      }
      out.push(mergeConfig(base[index], value))
    })
    return out
  }
  if (!isPlainObject(base) || !isPlainObject(incoming)) return cloneJson(incoming)
  const out = { ...base }
  for (const [key, value] of Object.entries(incoming)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (value === REDACTED) continue
    out[key] = mergeConfig(out[key], value)
  }
  return out
}

/** Read one mapping value as plain JSON data. */
function nodeValue(node, key) {
  if (!isMap(node) || !node.has(key)) return undefined
  const value = node.get(key)
  return typeof value?.toJSON === 'function' ? value.toJSON() : value
}

/** Drop redacted values instead of writing the placeholder into a new row. */
function stripRedacted(value) {
  if (value === REDACTED) return undefined
  if (Array.isArray(value)) return value.map(stripRedacted).filter(entry => entry !== undefined)
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    const next = stripRedacted(child)
    if (next !== undefined) out[key] = next
  }
  return out
}

/** A structural JSON clone that keeps Loader JavaScript markers. */
function cloneJson(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJson)
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    out[key] = cloneJson(child)
  }
  return out
}

/** Whether a value contains a Loader JavaScript expression marker. */
function containsJsMarker(value) {
  if (isJsMarker(value)) return true
  if (Array.isArray(value)) return value.some(containsJsMarker)
  if (isPlainObject(value)) return Object.values(value).some(containsJsMarker)
  return false
}

/** A tagged Loader `!!js` scalar. */
function jsScalar(expression) {
  const scalar = new Scalar(expression)
  scalar.tag = 'tag:yaml.org,2002:js'
  return scalar
}

/** Whether a value is one parsed `!!js` expression. */
function isJsMarker(value) {
  return isPlainObject(value)
    && Object.keys(value).length === 1
    && typeof value[JS_MARKER] === 'string'
}

/** Find the last non-insert top-level row with this id. */
function findOverrideIndex(doc, id) {
  return doc.contents.items.findLastIndex((node, index) => isMap(node) && doc.getIn([index, 'id']) === id && !node.has('insert'))
}

/** Find an inserted row by id. */
function findInsertedRow(doc, id) {
  for (let index = 0; index < doc.contents.items.length; index++) {
    const node = doc.contents.items[index]
    if (!isMap(node)) continue
    const insert = node.get('insert')
    if (!isSeq(insert)) continue
    for (const child of insert.items) {
      if (isMap(child) && child.get('id') === id) return { node: child, insert }
    }
  }
  return undefined
}

/** The last top-level `insert` sequence, if any. */
function lastInsertSequence(doc) {
  for (let index = doc.contents.items.length - 1; index >= 0; index--) {
    const node = doc.contents.items[index]
    if (isMap(node) && isSeq(node.get('insert'))) return node.get('insert')
  }
  return undefined
}

/** Write a patch through a same-directory temporary file. */
async function writePatchDocument(patchPath, doc) {
  const text = serializePatch(doc)
  const temporary = `${patchPath}.dsh-config-transfer.${process.pid}.tmp`
  try {
    await fsp.writeFile(temporary, text, { mode: 0o600 })
    await fsp.rename(temporary, patchPath)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Copy the current patch beside itself before the first import change. */
async function backupPatch(patchPath) {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const target = `${patchPath}.bak-${stamp}`
    await fsp.copyFile(patchPath, target)
    await fsp.chmod(target, 0o600).catch(() => {})
    return target
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Resolve the active profile or refuse the request. */
function requireProfile(ctx) {
  const profile = readService(ctx, 'profileContext')
  if (profile === undefined || typeof profile.dir !== 'string' || typeof profile.patchPath !== 'string') {
    throw new HttpError(409, 'this Host has no active DSH profile to transfer')
  }
  return {
    name: typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.length > 0
      ? process.env.DSH_PROFILE
      : path.basename(profile.dir),
    dir: profile.dir,
    patchPath: profile.patchPath,
  }
}

/** Read the running DSH version from the installation manifest. */
async function readDshVersion() {
  const dir = process.env.DSH_INSTALL_DIR
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** The install spec recorded for one exported bundle. */
function installSpecOf(item) {
  if (typeof item.source === 'string' && item.source.length > 0) return item.source
  if (isPlainObject(item.installTarget) && typeof item.installTarget.spec === 'string') return item.installTarget.spec
  return null
}

/** Whether a local spec points at a path that is absent on this machine. */
async function isMissingLocalSpec(spec) {
  const match = /^(?:link|file):(.*)$/i.exec(spec)
  const candidate = match !== null
    ? match[1]
    : /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(spec) ? spec : null
  if (candidate === null || candidate.length === 0) return false
  const expanded = candidate.startsWith('~/') ? path.join(os.homedir(), candidate.slice(2)) : candidate
  const absolute = path.resolve(expanded)
  return fsp.access(absolute).then(() => false, () => true)
}

/** Record one item outcome. */
function record(report, category, key, status, message) {
  report.categories[category].push({ key, status, message })
  if (status === 'applied') report.applied++
  else if (status === 'skipped') report.skipped++
  else report.failed++
}

/** Record a plugin-manager change result. */
function recordChange(report, category, key, result, verb) {
  if (result?.application === 'failed') {
    record(report, category, key, 'failed', result?.error?.diagnostic ?? result?.error?.code ?? 'the change failed')
    return
  }
  if (result?.application === 'restart-required') {
    report.restartRequired = true
    record(report, category, key, 'applied', `${verb}; restart required (${result.restartReason ?? 'restart'})`)
    return
  }
  record(report, category, key, 'applied', verb)
}

/** Read and parse one request body as JSON. */
async function readJson(request) {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'the request body is too large')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'the request body is not valid JSON')
  }
}

/** Normalize a category list from a request. */
function normalizeCategoryList(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(id => typeof id === 'string' && CATEGORIES.includes(id)))]
}

/** One JSON response. */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Run a handler and turn a refusal into JSON. */
async function guard(handler, request) {
  try {
    return await handler(request)
  } catch (error) {
    if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status)
    return json({ ok: false, error: messageOf(error) }, 500)
  }
}

/** One refusal with an HTTP status. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Read a Host service defensively. */
function readService(ctx, name) {
  try {
    const direct = ctx.get(name)
    if (direct !== undefined) return direct
  } catch { /* fall through to the property */ }
  try { return ctx[name] } catch { return undefined }
}

/** Whether a value is a plain JSON object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An error's message, defensively. */
function messageOf(error) {
  try { return error && error.message !== undefined ? String(error.message) : String(error) } catch { return 'unknown error' }
}

/** Yield for a bounded settle window. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
