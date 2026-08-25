# dsh-sub-cli 开发指南

## 当前阶段

新插件尚未开始实现。旧项目的可复用实现和文档已归档在 `reference/dsh-subagent-default-model/`，它们仅作为参考，不是新插件的发布入口。

开始开发前先阅读：

1. `CLI-MANAGER-HANDOFF.md`
2. `CLI-MANAGER-DESIGN.md`
3. `MIGRATION-INVENTORY.md`

## 建议项目布局

```text
lib/
├── index.js          # Host 插件入口、设置注册、工具注册
├── registry.js       # CLI 注册表和启动参数
├── paths.js          # 统一目录与配置隔离路径
├── status.js         # 安装/配置状态检测
├── dispatch.js       # 子进程派发、超时、取消、输出处理
└── client.js         # Web 插件配置卡片

test/
├── registry.test.mjs
├── status.test.mjs
├── dispatch.test.mjs
└── settings.test.mjs
```

包结构可在首次实现时最终确定。若仍采用旧项目的 `plugin/` 子目录布局，应在根文档中保持一致；若改为仓库根即 npm 包根，则同步调整 DSH 安装、测试和发布命令。

## 可复用模式

旧参考实现中最值得移植的部分：

- Host：`installSettingsSection`、`settingsNamespace` 和 `ctx.effect` 清理；
- Client：`settings.plugin.item`、折叠插件卡片、中英文 locale、settingsScope 快照和写后确认；
- Test：`MemorySettings`、Cordis Context 测试夹具和 fiber 卸载检查；
- Package：DSH `exports`、client entry、bundle patch 和 `npm pack --dry-run` 验证。

不要直接沿用对子代理服务的包装或 `subagent-default-model` 命名空间。

## 本地开发原则

- 外部 CLI 必须只从用户配置的统一目录解析，不隐式回退系统 PATH；
- 配置必须通过每个 CLI 的原生环境变量或参数隔离；
- 任务参数使用 argv 数组传递，避免 shell 拼接；
- 对 stdout、stderr、退出码、超时、取消和输出上限建立明确合同；
- 测试使用临时目录和假 CLI，不读取或覆盖真实用户配置；
- 不把 API Key、认证文件、CLI 配置或本机绝对路径提交到仓库。

## DSH GUI 验证

实现 Client 插件后，在当前 DSH Desktop 中验证时：

1. 构建受影响的 Web 插件产物；
2. 确认已有 GUI `http://127.0.0.1:43120` 加载的是该插件；
3. 若依赖 client-plugin HMR，先确认同一 DSH checkout 的 `pnpm run dev:web` watcher 正在运行；
4. 否则构建后刷新现有页面验证，不启动替代服务器；
5. 检查插件配置卡片、目录设置、CLI 状态、安装提示和派发结果。
