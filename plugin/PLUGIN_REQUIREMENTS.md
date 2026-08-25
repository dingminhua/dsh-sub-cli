# DSH 插件开发核心要求

本文件定义 `dsh-sub-cli` 作为 DSH 插件必须满足的工程红线。

## 1. 项目目录结构

```
plugin/
├── lib/
│   ├── index.js                 # 必需：Host 主逻辑（Cordis 插件）
│   ├── registry.js              # CLI 注册表 + argv 模板
│   ├── paths.js                 # 统一目录 + 配置隔离
│   ├── status.js                # 安装/版本检测
│   ├── dispatch.js              # 子进程无头派发
│   └── client.js                # 必需：Client 侧 UI（Web 设置卡片）
├── cordis.patch.yml             # 必需：bundle patch 声明
├── package.json                 # 必需：包配置
├── test/                        # 单元测试（node --test）
├── README.md                    # 必需：用户文档（中文）
├── README.en.md                 # 建议：英文文档
├── CHANGELOG.md                 # 建议：版本日志
└── LICENSE                      # 必需：许可证
```

## 2. package.json 关键字段

- `name`: `dsh-sub-cli`（小写/连字符）；
- `type`: `module`；`main`: `lib/index.js`；
- `exports`: `.` → `./lib/index.js`，`./client` → `./lib/client.js`，`./cordis.patch.yml`，`./package.json`；
- `dsh.bundle.patch`: `./cordis.patch.yml`；
- `dsh.client.platform`: `web`；`dsh.client.inject`: `["@deepseek-ai/dsh-client-ui-primitives"]`。

## 3. Host 红线

- 外部 CLI **只从统一目录解析**（`<cliDir>/bin/<bin>`），绝不回退系统 PATH；
- 配置必须通过每 CLI 原生环境变量隔离（`CODEX_HOME` 等），不触碰系统默认配置；
- 任务用 argv 数组传递，禁止 shell 字符串拼接；
- 对 stdout、stderr、退出码、超时、输出上限建立明确合同；
- 生命周期清理用 `ctx.effect`。

## 4. Client 红线

- 设置读写通过 `settingsScope`（绑定 `dsh-sub-cli` namespace）；
- 模型目录通过 `api.llm.models` 读取；
- UI 注入 `settings.plugin.item`（折叠卡片），不替换整块产品 UI。

## 5. 测试红线

- 用临时目录与假 CLI，不读取或覆盖真实用户配置；
- 不把 API Key、认证文件、CLI 配置或本机绝对路径提交到仓库。

## 6. 打包红线

- `npm pack --dry-run` 不包含 `reference/`、测试临时文件、凭据或用户配置；
- `files` 只列 `lib`、`cordis.patch.yml`、`LICENSE`、`README.md`、`README.en.md`、`CHANGELOG.md`。

## 7. 跨平台红线（macOS + Windows）

插件必须在其文档和开发目标中声明支持 macOS 与 Windows。实现红线：

- **路径**：统一目录下 `bin/`、`config-<cli>/` 的拼接使用 `path.join` / `path.sep`，不得硬编码 `/`；
- **系统命令**：`/bin/test`、`/bin/cp`、`/bin/mkdir`、`/bin/rm` 仅存在于 POSIX；Windows 上改用 `node:fs` 或 `cmd.exe` 等价命令并标注；
- **默认目录**：macOS `~/dsh-clis`，Windows `%USERPROFILE%\dsh-clis`；
- **子进程**：`ctx.subprocess.spawn` 的 argv 不包含 shell 语法（已满足）；
- **测试**：测试代码不依赖 POSIX 专属命令。Windows 适配可渐进式，但差异点必须用文档标注。
