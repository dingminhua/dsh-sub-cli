# dsh-sub-cli 发布指南

`dsh-sub-cli` 的发布入口是 `plugin/`（npm 包根），以下命令在 `plugin/` 目录执行。

## 发布前条件

- 包名、npm 名称、GitHub 地址和许可证（MIT）已确认；
- Host、Client、设置 schema、CLI 注册表和 `cli_dispatch` 工具已实现；
- `plugin/` 不依赖旧仓库绝对路径，不含 `reference/`；
- 全部单元测试通过；
- 已在 DSH Desktop 的真实 Web GUI 完成加载验证；
- README、CHANGELOG、市场描述与实际行为一致；
- `npm pack --dry-run` 不包含参考实现、测试临时文件、凭据或用户配置。

## 标准流程

```bash
npm test
npm pack --dry-run
npm version patch --no-git-tag-version
npm publish
```

发布前检查：

```bash
npm whoami
npm view dsh-sub-cli version
```

## Git 发布

在用户明确决定提交和发布后：

```bash
git status --short
git diff --check
git tag v<version>
git push origin main
git push origin v<version>
```

npm 账号启用 2FA 时，按 npm 交互提示在浏览器完成确认。

## 发布后验证

- `npm view dsh-sub-cli version` 返回本次版本；
- 从干净临时目录安装打包结果；
- DSH 能发现 Host 与 Client entry；
- 插件配置卡片能读写设置；
- 至少一个真实 CLI 的状态检测、派发、超时与错误回传符合文档。

## 现状说明

当前 `lib/index.js`（Host）实现 `installSettingsSection` 持久化 + `cli_dispatch` 工具，`lib/client.js`（Client）实现设置卡片。安装检测、统一目录迁移、每 CLI 实时状态 UI 需要 `@Remote` host 方法（typert）才能从 Client 触达，属于后续版本。
