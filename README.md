# Config Transfer

**Move a DeepSeek Harness profile's setup between machines — or keep a readable backup — as one JSON file, category by category.**

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) that adds a **Config transfer** page to Settings.

[中文说明](README.zh.md)

---

**License:** MIT · **Version:** 1.0.0 · **Tested with:** DSH 0.2.2-rc.3 (Desktop, macOS) · **Platforms:** Windows, macOS, Linux

## What it does

DSH keeps a profile's user configuration in two files: `cordis.patch.yml` (plugin rows, config overrides, MCP servers, agent presets) and `package.json` (the ordered `dsh.profile.bundles` selection). This plugin reads both, groups them into four categories, and writes one versioned JSON document.

| Category | What travels |
| --- | --- |
| **Plugin bundles** | The profile's selected bundles, with version, install source and enabled state. |
| **Plugin configuration** | Every config override and disable row in the profile patch, including model, permission and UI rows. |
| **MCP servers** | Rows that mount `@deepseek-ai/dsh-mcp-client`, with transport, command/URL, args and env. |
| **Agent presets** | Rows that declare `@deepseek-ai/dsh-agent-preset` in the profile patch. |

Shipped bundle defaults are **not** exported, so the file stays small and contains only what the user changed or added. Bundles that ship their own preset declarations travel with the bundle itself.

## Install

The plugin is a local bundle directory. Install it through DSH:

1. In the sidebar open **Plugins** → **Add plugin** and choose this directory, or run `dsh plugin --profile <profile> add link:/absolute/path/to/dsh-config-transfer`.
2. Restart DSH if the Plugins page reports a restart is required.
3. Open **Settings** → **Config transfer**.

There is no build step. When DSH runs the directory as a linked package, install its one dependency first:

```bash
npm install
```

(The repository ships `yaml` as a normal dependency, so a published copy needs no extra step.)

## Use it

### Export

1. Tick the categories you want. Unticked categories are omitted entirely.
2. Leave **Include secrets and environment values** off to replace token, password, API key and header values with `***REDACTED***`. Environment-variable names such as `DEMO_API_KEY` are kept because they are references, not secrets.
3. Choose **Export selected categories**. The browser downloads `dsh-config-<profile>-<timestamp>.json`.

The file records the profile name, DSH version, platform and creation time, plus `secretsIncluded`.

### Import

1. Choose a file. It is parsed and previewed in this browser only; nothing is written yet.
2. Tick the categories present in the file that you want to apply.
3. Optionally tick **Also install missing plugin bundles**. This runs package installation and executes third-party code; leave it off when the file came from an untrusted source.
4. Choose **Start import** and read the per-item report.

Before the first change the Host copies the current `cordis.patch.yml` to `cordis.patch.yml.bak-<timestamp>` beside it. Each row is reported as **Applied**, **Skipped** or **Failed**, with the reason. Without HMR, the page says the changes take effect after DSH restarts.

Redacted values are not written back: an imported `***REDACTED***` keeps the target machine's existing value for that field. Arrays with redacted entries are shortened only when a *new* row is created; existing rows keep their values.

## File format

```json
{
  "format": "dsh-config-transfer",
  "version": 1,
  "createdAt": "2026-11-15T14:20:00.000Z",
  "source": { "profile": "desktop", "dshVersion": "0.2.2-rc.3", "platform": "darwin", "arch": "arm64" },
  "secretsIncluded": false,
  "categories": {
    "bundles": { "items": [{ "name": "dsh-config-transfer", "enabled": true, "installed": true, "source": "link:/path" }] },
    "plugins": { "items": [{ "id": "ui-chat", "name": "@deepseek-ai/dsh-client-ui-chat", "kind": "override", "config": { "transcriptView": "standard" } }] },
    "mcp": { "items": [] },
    "presets": { "items": [] }
  }
}
```

`kind` is `insert` for a row the profile adds and `override` for a row it configures. A Loader `!!js` expression is stored as `{ "__dshConfigTransferJs": "process.env.X === '1'" }` and is written back as a tagged scalar.

## How it works

- The Host half (`index.js`) registers three same-origin routes: inventory, export and import. The browser half (`client.js`) is a plain module loaded by `window.__ModuleLoader__`; it renders the Settings page and downloads/uploads the JSON locally.
- Export reads `ctx.profileContext`, `ctx.pluginManager.listBundles()`, `ctx.configEditor`/`listPlugins()` (for row names) and the profile patch through the `yaml` document API, preserving comments outside edited nodes.
- Import prefers `ctx.configEditor.edit()` for live, enabled rows, so DSH validates the config through the normal Loader lifecycle. Rows that are absent, disabled, conditional or created by the document are written as YAML nodes in one atomic pass, after the backup.
- Bundle changes go through `ctx.pluginManager`: `setBundleEnabled()` for installed bundles and `installBundle(spec, { enabled: true })` only when the install option is ticked.
- After a write the Host waits for HMR's settle window and reads `listPlugins()` once to surface activation diagnostics. With no HMR it reports that a restart is required.

## Safety and privacy

- The page talks only to the local DSH Host. Export never sends configuration anywhere.
- Secrets are hidden by default. Enabling the option writes them to the downloaded file in clear text, so store that file accordingly.
- Import writes `cordis.patch.yml` (with a backup) and, if chosen, `package.json`/`pnpm-lock.yaml` through the plugin manager. It never reads session logs or credentials.
- Installing a bundle is running code. The import page requires an explicit tick for it.

## Compatibility and limits

- Requires a profile-backed DSH Web/Desktop Host that exposes `profileContext`, `pluginManager` and `configEditor`. Without a profile the routes answer “this Host has no active DSH profile”.
- The category model covers the profile user layer. A preset or plugin configuration that lives only in another bundle's own patch is restored by restoring that bundle.
- Local `link:`/`file:` sources are machine-specific. Import refuses a recorded local path that does not exist and names it in the report.
- Bundle order is not replayed exactly: enabling a bundle appends it to the selection, which can change precedence.
- Selection is per category, not per item. A whole category can be previewed in the file and then applied.
- The optional `settings.section.icon` slot is used when the running DSH declares it; older builds simply show the default Settings glyph.

## Development

```bash
npm install
node --test test/host.test.mjs   # engine checks, no DSH process needed
node --check index.js
node --check client.js
```

The tests cover category collection, secret redaction, environment references, update/insert behavior, backup creation, comment preservation, `!!js` disabled expressions and document validation.

To try a change in a live profile, install the directory as a local bundle again and restart or let HMR reload it.

## License

MIT © 2026 Yuan Xin
