/**
 * Config transfer — browser half of the `dsh-config-transfer` bundle.
 *
 * One Settings page under its own navigation entry:
 *
 * - four category cards (plugin bundles, plugin configuration, MCP servers,
 *   agent presets) with live counts read from the Host;
 * - one export action that downloads a versioned JSON document;
 * - one import flow that previews a chosen document, lets the user pick the
 *   categories to apply, and reports every outcome.
 *
 * No JSX and no imports beyond the browser module table's React: this is a
 * static bundle client module loaded by `window.__ModuleLoader__`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-config-transfer',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** This plugin's copy namespace. */
    const NS = 'configTransfer'

    /** Category ids in display order. */
    const CATEGORIES = ['bundles', 'plugins', 'mcp', 'presets']

    /** Same limit as the Host body reader. */
    const MAX_FILE_BYTES = 4 * 1024 * 1024

    const ZH = {
      nav: '配置导入导出',
      title: '配置导入导出',
      intro: '把本机 DSH 的插件包、插件配置、MCP 服务器和代理预设导出成一个 JSON 文件，或从文件中选择类别导入。导入插件配置、MCP 或预设前会自动备份 cordis.patch.yml；仅导入插件包时只调整 profile 的包选择。',
      profile: 'Profile',
      version: 'DSH 版本',
      refresh: '刷新清单',
      loading: '正在读取本机配置…',
      loadFailed: '读取配置失败',
      retry: '重试',
      items: '{count} 项',
      empty: '这个类别目前没有可导出的内容',
      bundleOn: '已启用',
      bundleOff: '未启用',
      bundleInstalled: '已安装',
      bundleMissing: '未安装',
      conditional: '条件启用',
      'category.bundles': '插件包',
      'category.bundles.desc': 'profile 选中的扩展包及其版本、来源与启用状态',
      'category.plugins': '插件配置',
      'category.plugins.desc': 'profile 补丁层里对插件条目的配置与禁用改写',
      'category.mcp': 'MCP 服务器',
      'category.mcp.desc': '通过 @deepseek-ai/dsh-mcp-client 接入的服务器连接',
      'category.presets': '代理预设',
      'category.presets.desc': 'profile 中声明的 @deepseek-ai/dsh-agent-preset 预设',
      'export.title': '导出',
      'export.hint': '只导出当前 profile 用户层的内容，不包含 DSH 自带插件的默认配置。',
      includeSecrets: '包含密钥与环境变量值',
      'includeSecrets.hint': '默认会隐藏识别出的 token、密码、API Key、授权头，以及 env/headers 中的值。导入时这些占位符会保留目标机器原有的值；仍建议检查下载的文件。',
      'export.button': '导出所选类别',
      exporting: '正在生成文件…',
      exported: '已生成 {name}',
      exportedRedacted: '已生成 {name}，隐藏了 {count} 个凭据字段',
      exportedSecrets: '已生成 {name}，其中包含明文凭据',
      exportEmpty: '至少选择一个类别',
      exportFailed: '导出失败',
      'import.title': '导入',
      'import.hint': '文件只在本机浏览器中解析预览，点“开始导入”后才会写入 profile；写入插件配置、MCP 或预设前会自动备份 cordis.patch.yml。',
      'import.choose': '选择配置文件…',
      parsing: '正在读取文件…',
      'import.preview': '导入预览',
      'import.source': '来源',
      'import.created': '创建时间',
      'import.categories': '选择要导入的类别',
      'import.start': '开始导入',
      'import.running': '正在写入配置，可能需要几秒钟…',
      'import.done': '导入完成',
      'import.partial': '导入结束，但有失败项',
      'import.failed': '导入失败',
      'import.backup': '改动前备份',
      'import.restart': '改动将在 DSH 重启后生效。',
      'import.noSelection': '至少选择一个类别',
      'import.invalid': '这不是有效的 dsh-config-transfer 配置文件',
      'import.tooLarge': '文件超过 4 MB，已拒绝读取',
      'import.redactedNote': '这个文件导出时已隐藏密钥；导入会保留目标机器现有的密钥值。',
      'import.installMissing': '同时安装缺失的插件包',
      'installMissing.hint': '插件包会执行代码，并且需要联网。只有确认这个文件可信时才勾选。',
      'import.cancel': '取消',
      'result.applied': '已应用',
      'result.skipped': '已跳过',
      'result.failed': '失败',
      'result.warnings': '运行警告',
      'result.close': '关闭结果',
      'file.bundles': '{count} 个插件包',
      'file.plugins': '{count} 条插件配置',
      'file.mcp': '{count} 个 MCP 服务器',
      'file.presets': '{count} 个代理预设',
      'error.http': '请求失败：HTTP {status}',
      'error.network': '无法连接 Host',
    }

    const EN = {
      nav: 'Config transfer',
      title: 'Config transfer',
      intro: 'Export this machine\'s plugin bundles, plugin configuration, MCP servers and agent presets into one JSON file, or import chosen categories from such a file. Import backs up cordis.patch.yml before touching plugin configuration, MCP or preset rows; a bundle-only import changes only the profile\'s selection.',
      profile: 'Profile',
      version: 'DSH version',
      refresh: 'Refresh inventory',
      loading: 'Reading this profile…',
      loadFailed: 'Could not read the profile',
      retry: 'Retry',
      items: '{count} items',
      empty: 'Nothing to export in this category yet',
      bundleOn: 'On',
      bundleOff: 'Off',
      bundleInstalled: 'Installed',
      bundleMissing: 'Not installed',
      conditional: 'Conditional',
      'category.bundles': 'Plugin bundles',
      'category.bundles.desc': 'Selected extension packages with version, source and enablement',
      'category.plugins': 'Plugin configuration',
      'category.plugins.desc': 'Config overrides and disable rows in the profile patch',
      'category.mcp': 'MCP servers',
      'category.mcp.desc': 'Server connections mounted through @deepseek-ai/dsh-mcp-client',
      'category.presets': 'Agent presets',
      'category.presets.desc': 'Preset declarations from @deepseek-ai/dsh-agent-preset',
      'export.title': 'Export',
      'export.hint': 'Only this profile\'s user layer is exported; built-in default configuration is not included.',
      includeSecrets: 'Include secrets and environment values',
      'includeSecrets.hint': 'By default recognized tokens, passwords, API keys, authorization headers and every value under env/headers is hidden. On import those placeholders keep the target machine\'s existing values; still inspect the downloaded file.',
      'export.button': 'Export selected categories',
      exporting: 'Building the file…',
      exported: 'Created {name}',
      exportedRedacted: 'Created {name}; {count} credential fields hidden',
      exportedSecrets: 'Created {name} with credentials in clear text',
      exportEmpty: 'Select at least one category',
      exportFailed: 'Export failed',
      'import.title': 'Import',
      'import.hint': 'The file is parsed and previewed in this browser only; nothing is written until you choose Start import. Import backs up cordis.patch.yml before touching plugin configuration, MCP or preset rows.',
      'import.choose': 'Choose a config file…',
      parsing: 'Reading the file…',
      'import.preview': 'Import preview',
      'import.source': 'Source',
      'import.created': 'Created',
      'import.categories': 'Categories to import',
      'import.start': 'Start import',
      'import.running': 'Writing configuration; this can take a few seconds…',
      'import.done': 'Import finished',
      'import.partial': 'Import finished with failures',
      'import.failed': 'Import failed',
      'import.backup': 'Backup before changes',
      'import.restart': 'Changes apply after DSH restarts.',
      'import.noSelection': 'Select at least one category',
      'import.invalid': 'This is not a valid dsh-config-transfer file',
      'import.tooLarge': 'The file is larger than 4 MB and was not read',
      'import.redactedNote': 'This file was exported with secrets hidden; import keeps the target machine\'s existing secret values.',
      'import.installMissing': 'Also install missing plugin bundles',
      'installMissing.hint': 'Bundles execute code and need network access. Tick this only when you trust the file.',
      'import.cancel': 'Cancel',
      'result.applied': 'Applied',
      'result.skipped': 'Skipped',
      'result.failed': 'Failed',
      'result.warnings': 'Runtime warnings',
      'result.close': 'Close results',
      'file.bundles': '{count} bundles',
      'file.plugins': '{count} configuration rows',
      'file.mcp': '{count} MCP servers',
      'file.presets': '{count} presets',
      'error.http': 'Request failed: HTTP {status}',
      'error.network': 'Could not reach the Host',
    }

    /**
     * One JSON POST to this bundle's Host routes.
     * @param path - route path relative to the page.
     * @param body - JSON body.
     * @returns parsed response body.
     */
    async function postJson(path, body) {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        })
      } catch (error) {
        const failure = new Error('network')
        failure.cause = error
        throw failure
      }
      const data = await response.json().catch(() => null)
      if (!response.ok || data === null || typeof data !== 'object') {
        const failure = new Error(typeof data?.error === 'string' ? data.error : 'http')
        failure.status = response.status
        throw failure
      }
      return data
    }

    /** One GET from this bundle's Host routes. */
    async function getJson(path) {
      let response
      try {
        response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
      } catch (error) {
        const failure = new Error('network')
        failure.cause = error
        throw failure
      }
      const data = await response.json().catch(() => null)
      if (!response.ok || data === null || typeof data !== 'object') {
        const failure = new Error(typeof data?.error === 'string' ? data.error : 'http')
        failure.status = response.status
        throw failure
      }
      return data
    }

    /** Render one error with the translated fallback. */
    function errorText(error, t) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'network') return t('error.network')
      if (message === 'http') return error?.status === 413 ? t('import.tooLarge') : t('error.http', { status: String(error?.status ?? '?') })
      return message
    }

    /** Trigger a JSON download in the page. */
    function downloadJson(payload, name) {
      const text = JSON.stringify(payload, null, 2)
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    /** A filesystem-safe timestamp for a download name. */
    function timestampName() {
      const now = new Date()
      const pad = value => String(value).padStart(2, '0')
      return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    }

    /** One small status chip. */
    function Chip({ children, tone }) {
      return h('span', { className: 'dct-chip' + (tone ? ' dct-chip-' + tone : '') }, children)
    }

    /** One category card with its checkbox, count and item preview. */
    function CategoryCard({ t, id, group, checked, onToggle }) {
      const items = Array.isArray(group?.items) ? group.items : []
      const count = typeof group?.count === 'number' ? group.count : items.length
      return h('div', { className: 'dct-card' + (checked ? ' dct-card-selected' : '') },
        h('label', { className: 'dct-card-head' },
          h('input', {
            type: 'checkbox',
            checked,
            onChange: event => onToggle(id, event.target.checked),
            'aria-label': t('category.' + id),
          }),
          h('span', { className: 'dct-card-title' }, t('category.' + id)),
          h(Chip, { tone: count > 0 ? 'count' : undefined }, t('items', { count })),
        ),
        h('p', { className: 'dct-card-desc' }, t('category.' + id + '.desc')),
        items.length === 0
          ? h('p', { className: 'dct-empty' }, t('empty'))
          : h('details', { className: 'dct-items' },
            h('summary', null, t('items', { count })),
            h('ul', null, items.slice(0, 80).map((item, index) => h('li', { key: id + ':' + index },
              h('code', { title: id === 'bundles' ? item.name : item.module ?? '' }, id === 'bundles'
                ? (item.name ?? '?')
                : (item.label ?? item.id ?? item.name ?? '?')),
              id !== 'bundles' && item.module && item.module !== item.label
                ? h('span', { className: 'dct-item-module', title: item.module }, item.module)
                : null,
              id === 'bundles'
                ? h('span', { className: 'dct-item-note' },
                  h('span', { className: 'dct-dot ' + (item.enabled ? 'dct-dot-on' : 'dct-dot-off') }),
                  item.enabled ? t('bundleOn') : t('bundleOff'),
                  ' · ',
                  item.installed ? t('bundleInstalled') : t('bundleMissing'))
                : h('span', { className: 'dct-item-note' },
                  item.disabled ? t('bundleOff') : item.conditional ? t('conditional') : null,
                  item.hasConfig ? ' · ' + String(item.configKeys ?? 0) + ' keys' : ''),
            ))),
            items.length > 80 ? h('p', { className: 'dct-empty' }, '+ ' + String(items.length - 80)) : null,
          ),
      )
    }

    /** One single-line status row for an import outcome. */
    function ResultRow({ row, t }) {
      const tone = row.status === 'failed' ? 'fail' : row.status === 'skipped' ? 'skip' : 'ok'
      return h('li', { className: 'dct-result-row' },
        h('span', { className: 'dct-dot dct-dot-' + tone }),
        h('code', { className: 'dct-result-key' }, row.key),
        h('span', { className: 'dct-result-status' }, t('result.' + row.status)),
        row.message ? h('span', { className: 'dct-result-message' }, row.message) : null,
      )
    }

    /** The full Settings page. */
    function ConfigTransferSection(props) {
      const t = typeof props?.t === 'function' ? props.t : (key => key)
      const [phase, setPhase] = useState('loading')
      const [inventory, setInventory] = useState(null)
      const [selected, setSelected] = useState({ bundles: true, plugins: true, mcp: true, presets: true })
      const [includeSecrets, setIncludeSecrets] = useState(false)
      const [installMissing, setInstallMissing] = useState(false)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [pending, setPending] = useState(null)
      const [importSelected, setImportSelected] = useState({})
      const [report, setReport] = useState(null)
      const fileRef = useRef(null)
      const reportRef = useRef(null)
      const mounted = useRef(true)
      const translate = useRef(t)
      translate.current = t

      const load = useCallback(async () => {
        setPhase('loading')
        setNotice(null)
        try {
          const data = await getJson('api/dsh-config-transfer.inventory')
          if (!mounted.current) return
          setInventory(data)
          setPhase('ready')
        } catch (error) {
          if (!mounted.current) return
          setPhase('error')
          setNotice({ tone: 'error', text: errorText(error, translate.current) })
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        void load()
        return () => { mounted.current = false }
      }, [load])

      useEffect(() => {
        if (report !== null) reportRef.current?.focus()
      }, [report])

      const toggle = (id, value) => setSelected(previous => ({ ...previous, [id]: value }))

      const chosen = CATEGORIES.filter(id => selected[id])

      const exportNow = async () => {
        if (chosen.length === 0) {
          setNotice({ tone: 'error', text: t('exportEmpty') })
          return
        }
        setBusy('export')
        setNotice(null)
        try {
          const data = await postJson('api/dsh-config-transfer.export', {
            categories: chosen,
            includeSecrets,
          })
          if (!data?.document) throw new Error('empty response')
          const profileName = inventory?.profile?.name ?? 'profile'
          const name = 'dsh-config-' + String(profileName).replace(/[^a-zA-Z0-9._-]+/g, '-') + '-' + timestampName() + '.json'
          downloadJson(data.document, name)
          const hidden = CATEGORIES.reduce((total, id) => total + (data.document.categories?.[id]?.items ?? [])
            .reduce((count, item) => count + (Array.isArray(item.redacted) ? item.redacted.length : 0), 0), 0)
          setNotice(includeSecrets
            ? { tone: 'warn', text: t('exportedSecrets', { name }) }
            : { tone: 'ok', text: hidden > 0 ? t('exportedRedacted', { name, count: hidden }) : t('exported', { name }) })
        } catch (error) {
          setNotice({ tone: 'error', text: t('exportFailed') + ': ' + errorText(error, t) })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }

      const chooseFile = () => fileRef.current?.click()

      const readFile = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setReport(null)
        setNotice(null)
        if (file.size > MAX_FILE_BYTES) {
          setNotice({ tone: 'error', text: t('import.tooLarge') })
          return
        }
        setBusy('parse')
        try {
          const text = await file.text()
          let parsed
          try { parsed = JSON.parse(text) } catch { throw new Error('invalid') }
          if (parsed === null || typeof parsed !== 'object'
            || parsed.format !== 'dsh-config-transfer' || parsed.version !== 1
            || parsed.categories === null || typeof parsed.categories !== 'object') {
            throw new Error('invalid')
          }
          const selection = {}
          let any = false
          for (const id of CATEGORIES) {
            const items = parsed.categories[id]?.items
            const has = Array.isArray(items) && items.length > 0
            selection[id] = has
            any = any || has
          }
          if (!any) throw new Error('invalid')
          setPending({ document: parsed, name: file.name, size: file.size })
          setImportSelected(selection)
        } catch (error) {
          setPending(null)
          setNotice({ tone: 'error', text: t('import.invalid') })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }

      const importNow = async () => {
        if (!pending) return
        const categories = CATEGORIES.filter(id => importSelected[id])
        if (categories.length === 0) {
          setNotice({ tone: 'error', text: t('import.noSelection') })
          return
        }
        setBusy('import')
        setNotice(null)
        try {
          const data = await postJson('api/dsh-config-transfer.import', {
            document: pending.document,
            categories,
            options: { installMissingBundles: installMissing },
          })
          if (!mounted.current) return
          setReport(data)
          setPending(null)
          if (data.applied > 0 || data.failed > 0) void load()
        } catch (error) {
          setNotice({ tone: 'error', text: t('import.failed') + ': ' + errorText(error, t) })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }

      const categoryRows = inventory?.categories ?? []
      const groupOf = id => categoryRows.find(row => row.id === id)
      const showInstallOption = Array.isArray(pending?.document?.categories?.bundles?.items)
        && pending.document.categories.bundles.items.length > 0

      return h('section', { className: 'dct-section', 'aria-label': t('title') },
        h('style', null, CSS),
        h('header', { className: 'dct-head' },
          h('h2', null, t('title')),
          h('p', null, t('intro')),
        ),
        h('div', { className: 'dct-meta' },
          inventory?.profile?.name
            ? h('span', null, t('profile') + ': ', h('code', null, inventory.profile.name))
            : null,
          inventory?.profile?.patchPath
            ? h('span', { className: 'dct-path' }, h('code', null, inventory.profile.patchPath))
            : null,
          inventory?.dshVersion
            ? h('span', null, t('version') + ': ', h('code', null, inventory.dshVersion))
            : null,
          h('button', {
            type: 'button', className: 'dct-link', disabled: phase === 'loading' || busy !== null,
            onClick: () => { void load() },
          }, t('refresh')),
        ),

        notice ? h('div', {
          className: 'dct-notice dct-notice-' + notice.tone,
          role: notice.tone === 'error' ? 'alert' : 'status',
        }, notice.text) : null,
        phase === 'error'
          ? h('div', { className: 'dct-notice dct-notice-error' }, h('span', null, t('loadFailed')), h('button', {
            type: 'button', className: 'dct-link', onClick: () => { void load() },
          }, t('retry')))
          : null,

        h('div', { className: 'dct-block' },
          h('h3', null, t('export.title')),
          h('p', { className: 'dct-hint' }, t('export.hint')),
          phase === 'loading'
            ? h('p', { className: 'dct-hint' }, t('loading'))
            : phase === 'error' ? null : h('div', { className: 'dct-grid' }, CATEGORIES.map(id => h(CategoryCard, {
              key: id, t, id, group: groupOf(id), checked: selected[id] === true, onToggle: toggle,
            }))),
          h('label', { className: 'dct-option' },
            h('input', {
              type: 'checkbox', checked: includeSecrets,
              onChange: event => setIncludeSecrets(event.target.checked),
              disabled: busy !== null,
            }),
            h('span', null, t('includeSecrets')),
          ),
          h('p', { className: 'dct-hint' }, t('includeSecrets.hint')),
          h('div', { className: 'dct-actions' },
            h('button', {
              type: 'button', className: 'dct-button dct-button-primary',
              disabled: busy !== null || chosen.length === 0 || phase !== 'ready',
              onClick: () => { void exportNow() },
            }, busy === 'export' ? t('exporting') : t('export.button')),
          ),
        ),

        h('div', { className: 'dct-block' },
          h('h3', null, t('import.title')),
          h('p', { className: 'dct-hint' }, t('import.hint')),
          h('input', {
            ref: fileRef, type: 'file', accept: 'application/json,.json',
            style: { display: 'none' }, onChange: event => { void readFile(event) },
          }),
          h('div', { className: 'dct-actions' },
            h('button', {
              type: 'button', className: 'dct-button',
              disabled: busy !== null,
              onClick: chooseFile,
            }, busy === 'parse' ? t('parsing') : t('import.choose')),
          ),

          pending ? h('div', { className: 'dct-preview' },
            h('div', { className: 'dct-preview-head' },
              h('strong', null, t('import.preview')),
              h('code', null, pending.name),
            ),
            h('div', { className: 'dct-meta' },
              pending.document.createdAt
                ? h('span', null, t('import.created') + ': ', h('code', null, String(pending.document.createdAt)))
                : null,
              pending.document.source?.profile
                ? h('span', null, t('import.source') + ': ', h('code', null,
                  String(pending.document.source.profile)
                  + (pending.document.source.dshVersion ? ' · DSH ' + String(pending.document.source.dshVersion) : '')))
                : null,
            ),
            pending.document.secretsIncluded === false
              ? h('p', { className: 'dct-hint dct-hint-warn' }, t('import.redactedNote'))
              : null,
            h('p', { className: 'dct-preview-label' }, t('import.categories')),
            h('div', { className: 'dct-grid dct-grid-compact' }, CATEGORIES.map((id) => {
              const group = pending.document.categories?.[id]
              const count = Array.isArray(group?.items) ? group.items.length : 0
              if (count === 0) return null
              return h('div', { key: 'import:' + id, className: 'dct-card dct-card-small' },
                h('label', { className: 'dct-card-head' },
                  h('input', {
                    type: 'checkbox', checked: importSelected[id] === true,
                    onChange: event => setImportSelected(previous => ({ ...previous, [id]: event.target.checked })),
                    disabled: busy !== null,
                  }),
                  h('span', { className: 'dct-card-title' }, t('category.' + id)),
                  h(Chip, { tone: 'count' }, t('file.' + id, { count })),
                ),
                h('details', { className: 'dct-items' },
                  h('summary', null, t('items', { count })),
                  h('ul', null, group.items.slice(0, 12).map((item, index) => h('li', {
                    key: 'item:' + index,
                  }, h('code', null, item.label ?? item.id ?? item.name ?? '?')))),
                  group.items.length > 12 ? h('p', { className: 'dct-empty' }, '+ ' + String(group.items.length - 12)) : null,
                ),
              )
            })),
            showInstallOption ? h('div', { className: 'dct-option-group' },
              h('label', { className: 'dct-option' },
                h('input', {
                  type: 'checkbox', checked: installMissing,
                  onChange: event => setInstallMissing(event.target.checked),
                  disabled: busy !== null,
                }),
                h('span', null, t('import.installMissing')),
              ),
              h('p', { className: 'dct-hint dct-hint-warn' }, t('installMissing.hint')),
            ) : null,
            h('div', { className: 'dct-actions' },
              h('button', {
                type: 'button', className: 'dct-button dct-button-primary',
                disabled: busy !== null,
                onClick: () => { void importNow() },
              }, busy === 'import' ? t('import.running') : t('import.start')),
              h('button', {
                type: 'button', className: 'dct-button',
                disabled: busy !== null,
                onClick: () => { setPending(null); setNotice(null) },
              }, t('import.cancel')),
            ),
          ) : null,
        ),

        report ? h('div', {
          className: 'dct-block dct-report', ref: reportRef, tabIndex: -1,
          role: 'status', 'aria-live': 'polite',
        },
          h('div', { className: 'dct-report-head' },
            h('h3', null, report.ok ? t('import.done') : t('import.partial')),
            h('div', { className: 'dct-summary' },
              h(Chip, { tone: 'ok' }, t('result.applied') + ' ' + String(report.applied ?? 0)),
              h(Chip, { tone: 'skip' }, t('result.skipped') + ' ' + String(report.skipped ?? 0)),
              h(Chip, { tone: report.failed > 0 ? 'fail' : undefined }, t('result.failed') + ' ' + String(report.failed ?? 0)),
            ),
          ),
          report.backup ? h('p', { className: 'dct-hint' }, t('import.backup') + ': ', h('code', null, report.backup)) : null,
          report.restartRequired ? h('p', { className: 'dct-hint dct-hint-warn' }, t('import.restart')) : null,
          CATEGORIES.map((id) => {
            const rows = report.categories?.[id]
            if (!Array.isArray(rows) || rows.length === 0) return null
            return h('div', { key: 'report:' + id, className: 'dct-result-group' },
              h('h4', null, t('category.' + id)),
              h('ul', { className: 'dct-result-list' }, rows.map((row, index) => h(ResultRow, {
                key: id + ':' + index, row, t,
              }))),
            )
          }),
          Array.isArray(report.warnings) && report.warnings.length > 0
            ? h('div', { className: 'dct-result-group' },
              h('h4', null, t('result.warnings')),
              h('ul', { className: 'dct-result-list' }, report.warnings.slice(0, 20).map((warning, index) => h('li', {
                key: 'warning:' + index, className: 'dct-result-row',
              }, h('span', { className: 'dct-dot dct-dot-skip' }), h('span', { className: 'dct-result-message' }, String(warning))))),
            )
            : null,
          h('div', { className: 'dct-actions' },
            h('button', { type: 'button', className: 'dct-button', onClick: () => setReport(null) }, t('result.close')),
          ),
        ) : null,
      )
    }

    /** The Settings navigation glyph for this section. */
    function SectionIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
      h('rect', {
        x: 2.25, y: 2.25, width: 11.5, height: 11.5, rx: 2.5,
        stroke: 'currentColor', strokeWidth: 1.2, opacity: 0.6,
      }),
      h('path', {
        d: 'M5 6.1h5.2M8.8 4.5 10.4 6.1 8.8 7.7',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M11 9.9H5.8M7.2 8.3 5.6 9.9l1.6 1.6',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    const CSS = `
.dct-section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);box-sizing:border-box}
.dct-section *{box-sizing:border-box}
.dct-head h2{margin:0 0 6px;font-size:18px;line-height:26px;font-weight:600}
.dct-head p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dct-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dct-meta code,.dct-hint code,.dct-preview-head code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-radius:5px;padding:2px 6px;word-break:break-all}
.dct-path{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dct-link{border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0}
.dct-link:disabled{opacity:.5;cursor:default}
.dct-block{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.dct-block h3{margin:0;font-size:14px;line-height:22px;font-weight:600}
.dct-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dct-hint-warn{color:var(--dsw-alias-state-warn-primary)}
.dct-notice-warn{color:var(--dsw-alias-state-warn-primary)}
.dct-option-group{display:flex;flex-direction:column;gap:3px}
.dct-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dct-grid-compact{grid-template-columns:1fr 1fr}
@media (max-width:640px){.dct-grid,.dct-grid-compact{grid-template-columns:1fr}}
.dct-card{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-base)}
.dct-card-selected{border-color:var(--dsw-alias-brand-primary)}
.dct-card-small{padding:8px}
.dct-card-head{display:flex;align-items:center;gap:8px;cursor:pointer}
.dct-card-head input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);flex:none}
.dct-card-title{font-size:13px;font-weight:600;line-height:18px}
.dct-card-desc{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.dct-empty{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dct-chip{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dct-chip-count{background:transparent;border:1px solid var(--dsw-alias-border-l2);margin-left:auto}
.dct-chip-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.dct-chip-skip{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dct-chip-fail{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.dct-items summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dct-items ul{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;max-height:180px;overflow:auto}
.dct-items li{display:flex;align-items:center;gap:8px;min-width:0}
.dct-items li code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dct-item-module{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dct-item-note{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.dct-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none;background:var(--dsw-alias-state-idle-primary)}
.dct-dot-on,.dct-dot-ok{background:var(--dsw-alias-state-success-primary)}
.dct-dot-off,.dct-dot-skip{background:var(--dsw-alias-state-warn-primary)}
.dct-dot-fail{background:var(--dsw-alias-state-error-primary)}
.dct-option{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-primary)}
.dct-option input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);flex:none}
.dct-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dct-button{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.dct-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dct-button:disabled{opacity:.55;cursor:default}
.dct-button-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dct-button-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.05)}
.dct-notice{border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;display:flex;align-items:center;gap:10px;background:var(--dsw-alias-bg-layer-2)}
.dct-notice-ok{color:var(--dsw-alias-state-success-primary)}
.dct-notice-error{color:var(--dsw-alias-state-error-primary)}
.dct-preview{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:10px;display:flex;flex-direction:column;gap:9px}
.dct-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dct-preview-head strong{font-size:13px}
.dct-preview-label{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dct-report{border-color:var(--dsw-alias-border-l2)}
.dct-report:focus{outline:none}
.dct-report-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.dct-report-head h3{margin:0}
.dct-summary{display:flex;gap:6px;flex-wrap:wrap}
.dct-result-group{display:flex;flex-direction:column;gap:5px}
.dct-result-group h4{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:600}
.dct-result-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto}
.dct-result-row{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:17px;min-width:0}
.dct-result-key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dct-result-status{color:var(--dsw-alias-label-secondary);flex:none}
.dct-result-message{color:var(--dsw-alias-label-secondary);white-space:normal;overflow-wrap:anywhere;min-width:0}
`

    return {
      /** Browser services this bundle needs before it applies. */
      inject: ['slots', 'locale'],
      /** Register the Settings section and its icon. */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'config-transfer: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'config-transfer',
          order: 40,
          label: () => t('nav'),
          locale: NS,
        }, ConfigTransferSection))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'config-transfer',
          order: 40,
          locale: NS,
        }, SectionIcon))
      },
    }
  },
})
