# dsh-sub-cli 发布指南

> 当前项目尚未形成可发布插件。本文件只定义发布前必须完成的检查，不能将 `reference/dsh-subagent-default-model/` 里的旧包发布为 `dsh-sub-cli`。

## 发布前条件

- 新插件包名、npm 名称、GitHub 地址和许可证已经确认；
- Host、Client、设置 schema、CLI 注册表和派发工具已实现；
- 不再依赖旧仓库绝对路径；
- 全部测试通过；
- 已在 DSH Desktop 的现有 Web GUI 中完成真实加载验证；
- README、CHANGELOG 和市场描述与实际行为一致；
- `npm pack --dry-run` 不包含 reference、测试临时文件、凭据或用户配置。

## 标准流程

以下命令需要在最终 npm 包根目录执行。若实现采用 `plugin/` 子目录，应先进入该目录；若仓库根就是包根，则直接执行。

```bash
npm test
npm pack --dry-run
npm version patch --no-git-tag-version
npm publish
```

发布前还应检查：

```bash
npm whoami
npm view dsh-sub-cli version
```

如最终 npm 包名不是 `dsh-sub-cli`，必须相应替换命令并更新所有文档。

## Git 发布

在用户明确决定提交和发布后：

```bash
git status --short
git diff --check
git tag v<version>
git push origin main
git push origin v<version>
```

不要在版本、测试结果或发布内容未确认时创建 tag。npm 账号启用 2FA 时，应按 npm 交互提示在浏览器完成确认。

## 发布后验证

- `npm view <package> version` 返回本次版本；
- 从干净临时目录安装打包结果；
- DSH 能发现 Host 和 Client entry；
- 插件配置卡片能读写设置；
- 假 CLI 和至少一个真实 CLI 的状态检测、派发、超时与错误回传符合文档；
- GitHub release/tag 和 npm 版本一致。

## 旧项目清理关系

清理 `dsh-subagent-default-model` 不等于发布 `dsh-sub-cli`。删除旧项目之前，先确保本仓库迁移资料已提交并推送；新插件发布则必须等新实现完成并通过上述验证。
