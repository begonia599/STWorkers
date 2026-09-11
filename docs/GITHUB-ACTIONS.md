# GitHub Actions 预装发布

日期：2026-09-10。
当前优先路线是用 GitHub Actions 接替开发电脑完成“准备插件、打包、部署”。
不是在网页点击安装后启动一个后台任务，也不是让 Worker 继续解压 Actions 下载的 ZIP。
在线安装后端的性能优化留到后续细化；已有在线安装功能不删除，也不据此标记免费资源门槛通过。

## 当前范围

- 复用 P3 已验证的随包方式，预装酒馆助手 4.9.5 与 EJS 1.17.9。
- 固定上游提交和 ZIP SHA-256，使用原编译文件，不运行插件的 npm 生命周期、构建或 Git hook。
- 输出到 `cloudflare/.build/assets-p3`，运行路径仍为原版 `scripts/extensions/third-party/`。
- 默认只构建和 dry-run；显式勾选后才更新一个已经初始化的个人实例。
- 本轮不自动开通账号、创建 Worker/D1/R2、执行数据库迁移或初始化密钥。
  从零部署仍需先走 `CLOUD-TEST.md`；完整的一键首次初始化属于尚未完成的 P5。
- 新增工作流不会发布 npm、Docker、GitHub Release 或上传插件资源 artifact。
  原 ST 的十个工作流已移到 `.github/upstream-workflows/` 仅作参考，
  不参与本仓库 push、定时、Issue、PR 或发布事件。当前仅激活本手动工作流。

这轮只完成本地实现和验证，未推送仓库、配置 GitHub Secrets 或启动真实 Actions。
GitHub 托管 Linux runner 和 Actions 到 Cloudflare 的实际部署仍待验证。

## 使用入口

工作流为 `.github/workflows/stworkers-deploy.yml`，名称：
`STWorkers - Prepare Plugins and Deploy`。

仓库代码及 Git 历史推送到默认分支后：

1. 打开自己的 GitHub 仓库，在 Actions 中选择该工作流。
2. 第一次保持 `deploy` 未勾选，点击 Run workflow，先确认依赖、测试、插件下载与打包通过。
3. 配置下面的 Variables 和 Secret。
4. 再次 Run workflow，选择默认分支并勾选 `deploy`，才会更新现有实例。
5. 查看部署步骤输出的实际地址和状态，再进行页面、模型及角色卡验收。

这是网页操作入口，不要求用户在手机运行 Node 或终端。
手机 GitHub 页面全流程尚未实测，不承诺所有首次账号开通和授权步骤均已无障碍。
测试需要读取 `upstream-lock.json` 对应的原 ST Git 对象，因此 checkout 使用完整历史；
不要只上传一份源码 ZIP 而丢弃这个基线。

## 配置

在仓库 Settings -> Secrets and variables -> Actions 中配置。
只构建时可以不填 Cloudflare 配置，生成的占位 ID 仅用于本地 dry-run，不允许上传。

Variables：

| 名称 | 内容 |
| --- | --- |
| `STWORKERS_WORKER_NAME` | 已有 Worker 的准确名称；不填写时构建示例名为 `stworkers` |
| `CLOUDFLARE_ACCOUNT_ID` | 该 Worker 所属账号的 32 位 Account ID |
| `STWORKERS_D1_DATABASE_ID` | 现有 D1 的 UUID，不是名称 |

Secret：

| 名称 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 用于更新自己账号中 Worker 的 Cloudflare API Token |

沿用当前个人实例命名约定：D1 名称为 `<Worker 名称>-db`，R2 为 `<Worker 名称>-files`。
例如 Worker 名称为 `stworks-cloud-test` 时，两个资源名分别为
`stworks-cloud-test-db` 和 `stworks-cloud-test-files`。
不要填入另一套数据库或新桶名；预检发现绑定不符会停止，不自动迁移或替换。

Token 可按 Cloudflare 官方 CI 文档从 Edit Cloudflare Workers 权限策略建立，
只限定到目标账号；还需能够读取本工作流检查的 D1 和 R2 资源元数据。
最小权限组合仍需真实 Actions 验证。不要使用 Global API Key，不要把 Token 写进源码或工作流。

**不需要把 `AUTH_PASSWORD`、`DATA_KEY` 或模型 API Key 复制到 GitHub。**
部署要求现有 Worker 已经有前两项 secret，通过继承保留原值。
缺少任一项就停止，不先发布无保护应用，也不尝试补写或生成替代密钥。
凭据仍应由所有者独立备份；此工作流不是密钥或数据备份工具。

## 执行过程

1. 手动触发；只有仓库默认分支可以执行上传，其他分支最多构建验证。
2. 安装锁文件中的项目依赖，两次 `npm ci` 都带 `--ignore-scripts`。
3. 执行 `cloudflare/test` 安全与契约测试。
4. 从固定 `codeload.github.com` 提交地址下载两份 ZIP，无 Cookie、所有者或 Cloudflare 凭据。
5. 有界读取，拒绝重定向和非 200 响应；哈希不符立即停止。
6. 调用现有 `packagePlugins` 和原版静态资源构建器，保留许可与完整源归档。
7. 核对资源清单、插件基线、私有文件排除与鉴权配置，执行 Wrangler dry-run。
8. 仅勾选 `deploy` 时，部署步骤获得 Cloudflare Token；先只读核对现有 Worker 绑定、D1 和 R2。
9. 使用固定 Wrangler 4.129.1 更新，开启 `--strict`，关闭资源自动预配和创建，
   不传 `--secrets-file`，不运行迁移或密钥写命令。
10. 命令成功后再读绑定核对。后置核对失败会明确说明部署命令已经运行，不伪称没有上传。

源码、依赖和仓库维护权限仍需要信任。下载的插件不执行构建脚本，不等于整个 CI 是不可信代码沙箱。
Cloudflare Token 只注入最后一个步骤，不在下载、依赖安装或构建步骤的环境中。
同一仓库的本工作流串行执行，不自动取消一个已经开始的部署。

生成的配置和离线回执保存在被忽略的 `cloudflare/.build/actions/`。
不读取开发电脑的 `.deploy`、`.dev.vars`、聊天、私有角色卡或密钥。
下载和本地打包输入保留在 `.build/actions-input-*`，GitHub 临时 runner 结束后不作为 artifact 上传。

## 插件版本与数据

本次复用原锁定插件，不是自动追随上游 latest，也不是永久只允许这两个插件。
版本变化应同时审查 `upstream-lock.json`、`plugin-package.mjs` 的提交/哈希和兼容证据。
未纳入随包清单的其他插件不在这份工作流的预装范围内。

部署不改 D1 的设置、聊天、变量或插件安装记录，也不清理 R2。
已在线安装的版本、卸载 tombstone 以及已有 bundled 指针仍按当前后端的优先级处理。
因此重新部署不等于强制重装插件；更改未来的随包提交还需要核对旧安装/回退记录，
不能用一次静态上传宣称旧指针已经自动迁移。

预装路径避开了 Worker 在线下载和解压安装过程，但聊天 API、鉴权及存储仍消耗 Worker 资源。
GitHub 配额、Cloudflare 套餐与免费资源验收、浮动 CDN 可达性、源码大包下载稳定性
以及完整 MVU/真实模型工作流仍需分别验证。
保留许可与源码不是公开再分发许可结论；公开发行前仍须完成原有许可审查。

## 本地复现与证据

在项目根目录安装依赖后执行：

```powershell
npm.cmd --prefix cloudflare test
node cloudflare/scripts/github-actions.mjs build
node cloudflare/scripts/check-actions-local.mjs <提供-playwright-的-package.json> <Chrome-可执行文件>
```

本地 `build` 会真实下载公开 ZIP 并替换生成的 `.build/assets-p3`，不上传。
本地 `deploy` 默认拒绝执行，不应伪造 GitHub 环境变量绕过保护。
浏览器脚本使用全新临时 D1/R2、随机登录密码和回环端口，不读取所有者数据或调用模型；
测试后关闭运行时和浏览器。

2026-09-10 本地验证：

- 215 项测试通过，其中新增 16 项 Actions 专项。
- 两插件真实网络下载，SHA-256 与原固定归档一致。
- 生成 742 个静态文件，共 77,358,564 字节；原版插件 manifest、JS/CSS 与源码 ZIP 字节核对通过。
- 带插件的 Actions 路径与普通无插件构建的 dry-run 均通过。
- 原版桌面和全新手机上下文加载两个插件；合成 Helper 全局变量刷新后保留。
- 浏览器验收过程中在线安装/更新请求 0、Worker 出站下载 0、R2 对象 0、
  D1 扩展归档记录 0；页面异常和 HTTP 错误均为 0。
- 这不是真实 GitHub Actions、云端发布、完整卡片或免费套餐验收。

具体回归记录见 `VERIFICATION.md`。真实 Actions 运行及部署证据尚未产生。

参考官方文档：

- Cloudflare Workers / CI & CD / GitHub Actions。
- GitHub Actions / Manually running a workflow、Workflow syntax、Secure use。
- 固定版本 Wrangler 的 required secrets 继承实现与本地 dry-run。
