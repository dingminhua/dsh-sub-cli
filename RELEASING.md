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

当前已实现并实测（macOS + codex 0.149.1 / claude 2.1.247 / qwen 0.22.2，六轮端到端，见 `plugin/VERIFICATION-FLOW.md`）：

- Host（`lib/index.js`）：设置持久化；`cli_install` / `cli_check` / `cli_test` / `cli_remove`（npm 安装到统一目录、版本探测、协议验证含工具续接、移除）；三 CLI 的 direct 持续会话（11 个 session 工具）、relay 子代理（`managed_cli_submit`）、无头 `cli_dispatch`；driver 层统一权限拦截（勾选静默放行 / 未勾选弹窗或自动拒绝）；会话持久化（`sessions.json`，Host 重启后 reattach 同一 thread）。
- Client（`lib/client.js`）：设置卡片（Provider / 模型 / 推理强度 / 权限三档下拉 / approval / autoContinue / 轮次超时）及每 CLI 的安装 / 测试 / 更新 / 删除操作。

尚未完成：Windows 真机验证（`winShimArgv` 已就位，清单见 `Windows-Test-Checklist.md`）；读取权限无运行时强制点（三档 UI 下 read 恒 true，仅手改 `settings.yaml` 才会出现 `read:false`，此时读操作仍放行——README 已注明）。
