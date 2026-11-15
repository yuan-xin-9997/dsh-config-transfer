# 配置导入导出

**把一个 DeepSeek Harness profile 的配置装进一个 JSON 文件，按类别迁移到另一台机器，或留作可读的备份。**

这是 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，在设置中新增「配置导入导出」页面。

[English](README.md)

---

**许可证：** MIT · **版本：** 1.0.0 · **测试环境：** DSH 0.2.2-rc.3（Desktop，macOS）· **平台：** Windows、macOS、Linux

## 功能

DSH 把 profile 的用户配置放在两个文件里：`cordis.patch.yml`（插件条目、配置改写、MCP 服务器、代理预设）和 `package.json`（有序的 `dsh.profile.bundles` 选择）。本插件读取这两处，按四个类别整理，写出一个带版本号的 JSON 文件。

| 类别 | 包含的内容 |
| --- | --- |
| **插件包** | profile 选中的扩展包，以及版本、安装来源和启用状态。 |
| **插件配置** | profile 补丁层里的配置改写与禁用条目，包括模型、权限和界面设置。 |
| **MCP 服务器** | 挂载 `@deepseek-ai/dsh-mcp-client` 的条目，含 transport、命令/URL、参数与环境变量。 |
| **代理预设** | profile 补丁里声明 `@deepseek-ai/dsh-agent-preset` 的条目。 |

DSH 自带 bundle 的默认配置不会导出，因此文件只包含你实际修改或新增的内容。bundle 自带的预设声明会随 bundle 一起恢复。

## 安装

这是一个本地 bundle 目录：

1. 在侧边栏打开 **插件** → **添加插件**，选择本目录；或运行 `dsh plugin --profile <profile> add link:/本目录的绝对路径`。
2. 如果插件页提示需要重启，重启 DSH。
3. 打开 **设置** → **配置导入导出**。

不需要构建。DSH 以链接方式加载本目录时，请先安装唯一依赖：

```bash
npm install
```

（仓库把 `yaml` 声明为普通依赖；发布到 npm 后安装时无需额外操作。）

## 使用

### 导出

1. 勾选需要导出的类别，未勾选的类别不会写进文件。
2. 默认不勾选「包含密钥与环境变量值」：token、密码、API Key 和请求头会变成 `***REDACTED***`。像 `DEMO_API_KEY` 这样的环境变量名会保留，因为它只是引用而不是密钥。
3. 点「导出所选类别」，浏览器会下载 `dsh-config-<profile>-<时间>.json`。

文件会记录 profile 名、DSH 版本、平台和创建时间，以及 `secretsIncluded`。

### 导入

1. 选择文件。它只在当前浏览器里解析和预览，此时还不会写入任何内容。
2. 勾选文件里存在、且你希望应用的类别。
3. 可选勾选「同时安装缺失的插件包」。这会执行包安装并运行第三方代码；文件来源不可信时不要勾选。
4. 点「开始导入」，查看逐条结果。

第一次改动插件配置、MCP 或预设前，Host 会把当前的 `cordis.patch.yml` 备份为同目录下的 `cordis.patch.yml.bak-<时间>`；只导入插件包时只调整 profile 的包选择。每条结果会标为 **已应用**、**已跳过** 或 **失败**，并给出原因。没有 HMR 时，页面会提示重启 DSH 后生效。

被隐藏的密钥不会被写回：导入时遇到 `***REDACTED***` 会保留目标机器上该字段原有的值。只有*新建*条目时，数组中被隐藏的元素才会被移除；已有条目会保留原值。

## 文件格式

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

`kind` 为 `insert` 表示 profile 新增的条目，`override` 表示 profile 改写的条目。Loader 的 `!!js` 表达式存为 `{ "__dshConfigTransferJs": "process.env.X === '1'" }`，导入时再写回带标签的标量。

## 实现方式

- Host 端（`index.js`）注册三个同源路由：清单、导出、导入。浏览器端（`client.js`）是由 `window.__ModuleLoader__` 加载的普通模块，负责设置页、下载和本地解析文件。
- 导出读取 `ctx.profileContext`、`ctx.pluginManager.listBundles()`、`ctx.configEditor` / `listPlugins()`（补全条目模块名）以及 profile 补丁，使用 `yaml` 文档 API，被修改节点之外的注释会保留。
- 导入优先用 `ctx.configEditor.edit()` 处理在线且已启用的条目，让 DSH 走正常的 Loader 生命周期校验配置。缺失、禁用、带条件或文件中新建的条目则在备份之后一次性原子写入 YAML 节点。
- 插件包通过 `ctx.pluginManager` 变更：已安装的用 `setBundleEnabled()`；只有勾选安装选项时才调用 `installBundle(spec, { enabled: true })`。
- 写入后 Host 等待 HMR 的稳定窗口，并读取一次 `listPlugins()` 以显示激活诊断；没有 HMR 时明确提示需要重启。

## 安全与隐私

- 页面只和本机 DSH Host 通信，导出不会把配置发到任何地方。文件会包含本机 profile 路径和 bundle 来源（绝对路径与用户名），请按机器信息处理。
- 默认隐藏识别出的凭据以及 `env`/`headers` 中的所有值，并按值识别常见 token 格式。勾选包含凭据后，下载文件里会是明文，请妥善保管。启发式规则无法覆盖所有自定义密钥，分享前请检查文件。
- 导入写入 `cordis.patch.yml`（有备份），并在勾选时通过插件管理器写入 `package.json` / `pnpm-lock.yaml`。它不读取会话日志或凭据。
- 安装 bundle 就是执行代码。导入页要求你明确勾选才会安装。

## 兼容性与限制

- 需要带 profile 的 DSH Web/Desktop Host，并提供 `profileContext`、`pluginManager` 和 `configEditor`。没有 profile 时路由会返回「this Host has no active DSH profile」。
- 类别模型覆盖 profile 用户层。只存在于其他 bundle 自带补丁里的预设或插件配置，会随该 bundle 一起恢复。
- `link:`/`file:` 本地来源与机器相关。导入时如果记录的本地路径不存在，会拒绝并在结果里写明。
- bundle 顺序不会精确重放：启用一个 bundle 会把它追加到选择列表末尾，可能改变优先级。
- 选择粒度是类别而非单条。文件里可以预览整个类别，再决定是否应用。
- 运行中的 DSH 声明了 `settings.section.icon` 时使用自定义图标；旧版本会显示默认设置图标。

## 开发

```bash
npm install
node --test test/host.test.mjs   # 不需要 DSH 进程
node --check index.js
node --check client.js
```

测试覆盖类别收集、密钥隐藏、环境变量引用、改写/新增、备份、注释保留、`!!js` 禁用表达式和文档校验。

要在本机 profile 里试用改动，重新以本地 bundle 安装本目录，然后重启或等待 HMR 重载。

## 许可证

MIT © 2026 Yuan Xin
