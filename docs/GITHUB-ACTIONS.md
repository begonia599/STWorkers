# GitHub Actions 预装发布

更新日期：2026-09-11。
当前优先路线是用 GitHub Actions 接替开发电脑完成“准备插件、打包、部署”。
不是在网页点击安装后启动一个后台任务，也不是让 Worker 继续解压 Actions 下载的 ZIP。
在线安装后端的性能优化留到后续细化；已有在线安装功能不删除，也不据此标记免费资源门槛通过。

## 当前范围

- 从根目录 `plugins.txt` 读取预装清单，默认仍为酒馆助手 4.9.5 与 EJS 1.17.9。
- `plugins.lock.json` 保存具体提交、ZIP SHA-256 和打包布局；普通重建沿用旧版本，
  新增条目自动解析，只有显式勾选 `update_plugins` 才检查已有插件的新版本。
- 使用仓库已有编译文件，不运行插件的 npm 生命周期、构建命令或 Git hook。
- 输出到 `cloudflare/.build/assets-p3`，运行路径仍为原版 `scripts/extensions/third-party/`。
- 默认只构建和 dry-run；显式勾选后才更新一个已经初始化的个人实例。
- 本轮不自动开通账号、创建 Worker/D1/R2、执行数据库迁移或初始化密钥。
  从零部署仍需先走 `CLOUD-TEST.md`；完整的一键首次初始化属于尚未完成的 P5。
- 新增工作流不会发布 npm、Docker、GitHub Release 或上传插件资源 artifact。
  原 ST 的十个工作流已移到 `.github/upstream-workflows/` 仅作参考，
  不参与本仓库 push、定时、Issue、PR 或发布事件。当前仅激活本手动工作流。

2026-09-11，清单改造前的固定两插件版本已推送到所有者私有仓库，首次 GitHub 托管 Linux 构建成功。
本次 `deploy=false`，没有配置 GitHub Secrets、通过 Actions 部署 Cloudflare 或修改云端资源。
Actions 到 Cloudflare 的 Token 权限、真实更新和运行验收仍待验证。
清单改造随后已推送，2026-09-11 GitHub Actions #2 成功：
247 项测试、默认两插件打包和锁文件无变化路径通过；
`deploy=false`、`update_plugins=false`，没有额外锁文件提交或 Cloudflare 部署。
有变化的锁文件自动回写仍未经过真实 GitHub 验证，不能用本次无变化路径替代。

## 用户只编辑清单

首次 Fork 后，按需编辑根目录 `plugins.txt`；只用默认两插件则无需修改。
一行一个公开 GitHub 仓库地址，例如：

```text
https://github.com/N0VI028/JS-Slash-Runner
https://github.com/zonde306/ST-Prompt-Template
```

添加插件时增加一行、保存提交，再运行工作流。无需编辑打包脚本或手算哈希。
空行及以 `#` 开头的注释会被忽略；支持 `.git` 后缀，
高级用法为 `https://github.com/owner/repo#branch-or-tag-or-commit`。
没有后缀表示首次解析默认分支；之后仍锁定到已保存的提交，不自动追随上游。

两个复选框含义不同：

- `deploy`：构建验证及保存锁文件后，更新已有 Cloudflare 实例。默认关闭。
- `update_plugins`：检查清单中已有插件的新版本。默认关闭；只添加新插件不需要勾选。

成功构建后，默认分支工作流使用 GitHub 内置临时 `GITHUB_TOKEN`，
仅将生成的 `plugins.lock.json` 保存为一次提交；没有变化时不提交。
普通用户不需要额外申请 GitHub PAT，也不手动编辑锁文件。
即使 `deploy=false`，成功构建也可能保存新锁文件，但不会操作 Cloudflare。
构建其他分支只能验证，不回写锁文件，也不部署。
本地 `build` 只生成 `.build/actions/plugins.lock.json`，不会修改根目录锁文件或远端仓库。

保存前校验本次运行的分支、提交、清单、构建回执及远端 HEAD。
只修改锁文件，使用非强制更新；并发提交、分支保护或写权限不足时停止，
不自动放宽保护、不重试覆盖。请检查运行提示，再从最新默认分支重跑。
工作流拥有仓库 `contents: write` 权限，临时 Token 仅传给保存步骤；
checkout 不持久化凭据，插件下载与打包步骤不注入该 Token。
这是可信仓库中的构建流程，不是不可信代码沙箱。

删掉一行只取消下次部署的预装；空清单也是合法输入。
不会清理聊天、设置、变量或 R2，已在线安装的插件与卸载记录仍有优先级。
曾被记录到数据库的 bundled 指针会跟随当前部署的版本或移除，
旧 bundled 回退目标已经不在部署包内时仍明确拒绝回退，不伪称旧代码可恢复。

当前支持有根目录 `manifest.json` 及可直接运行的 JS/CSS 的公开 GitHub 前端扩展，
包括根目录脚本、相对导入、HTML 模板、翻译、图片及字体。
不自动编译仅有源码的分支，不支持私有仓库认证，也不据此宣称 Node 后端插件能在 Workers 运行。
缺失 manifest 引用资源、路径冲突、同名仓库目录、下载或哈希失败会停止构建。
上限为 32 个条目、每包 25 MiB、所选压缩归档合计 128 MiB，最终资源另受资产检查约束。
首次新增或更新时的哈希是完整性锁定，不是对插件安全性或许可的审核结论。

“首次授权后免手填 Cloudflare Token”的部署入口、自动创建资源和初始化密钥仍属于未完成的 P5；
当前 Actions 直接部署现有实例仍使用下节的 Cloudflare Secret。

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
4. 按清单及锁文件从固定 `codeload.github.com` 提交地址下载 ZIP，无 Cookie、所有者或 Cloudflare 凭据；
   仅新条目、改动的 ref 或主动更新才调用 GitHub 公共 API 解析提交。限流或重定向明确失败。
5. 有界读取，拒绝重定向和非 200 响应；哈希不符立即停止。
6. 调用现有 `packagePlugins` 和原版静态资源构建器，保留许可与完整源归档。
7. 核对资源清单、所选插件锁、私有文件排除与鉴权配置，执行 Wrangler dry-run；
   通过后在默认分支保存锁文件。下载或构建失败不会生成可部署的成功回执。
8. 仅勾选 `deploy` 时，部署步骤获得 Cloudflare Token；先验证锁文件保存回执，
   再只读核对现有 Worker 绑定、D1 和 R2。
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

默认清单复用原锁定插件，不自动追随上游 latest，也不永久只允许这两个插件。
用户预装由 `plugins.txt` 和自动保存的 `plugins.lock.json` 管理。
`upstream-lock.json` 与脚本中的 `PLUGIN_BASELINES` 继续保留为原 P3 对照基线，
不是新增插件白名单，也不随用户清单改变而改写历史兼容证据。

部署不改 D1 的设置、聊天、变量或插件安装记录，也不清理 R2。
已在线安装的版本、卸载 tombstone 仍按当前后端的优先级处理。
bundled 当前指针以本次部署清单为准，不写数据库做破坏式迁移。
因此重新部署不等于强制重装插件，也不保证旧部署中的 bundled 回退文件仍存在。

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
node cloudflare/scripts/check-actions-local.mjs <提供-playwright-的-package.json> <Chrome-可执行文件> --with-list-fixture
```

本地 `build` 会真实下载公开 ZIP 并替换生成的 `.build/assets-p3`，不上传。
本地 `deploy` 默认拒绝执行，不应伪造 GitHub 环境变量绕过保护。
浏览器脚本使用全新临时 D1/R2、随机登录密码和回环端口，不读取所有者数据或调用模型；
测试后关闭运行时和浏览器。
`--with-list-fixture` 在独立复制的静态资源目录中，经清单解析及真实打包函数添加一个合成第三插件，
检查根目录模块、相对导入、模板和 CSS。不会修改正式清单、锁文件或默认两插件的构建产物。

2026-09-10 本地验证：

- 215 项测试通过，其中新增 16 项 Actions 专项。
- 两插件真实网络下载，SHA-256 与原固定归档一致。
- 生成 742 个静态文件，共 77,358,564 字节；原版插件 manifest、JS/CSS 与源码 ZIP 字节核对通过。
- 带插件的 Actions 路径与普通无插件构建的 dry-run 均通过。
- 原版桌面和全新手机上下文加载两个插件；合成 Helper 全局变量刷新后保留。
- 浏览器验收过程中在线安装/更新请求 0、Worker 出站下载 0、R2 对象 0、
  D1 扩展归档记录 0；页面异常和 HTTP 错误均为 0。
- 这不是真实 GitHub Actions、云端发布、完整卡片或免费套餐验收。

具体本地回归记录见 `VERIFICATION.md`；下节为独立的托管构建证据，不代表真实部署。

2026-09-11 首次上传前追加验证：归档上游十个工作流，新增启用工作流清单测试；
216 项本地测试通过（Actions 专项 17 项），普通构建与 Wrangler dry-run 再次通过。

## GitHub 托管验证

2026-09-11，经所有者授权，代码首次推送到私有仓库
`begonia599/STWorkers` 的 `main`，只手动触发一次构建验证。

- 运行：[Actions #1](https://github.com/begonia599/STWorkers/actions/runs/34605582171)，
  attempt 1，结论 `success`。
- 测试提交：`7383a027aed30e5c09b5daf15d8138c3c9283e2c`。
- 环境：GitHub 托管 `ubuntu-24.04`、Node 22.14.0；任务运行约 71 秒，
  北京时间 21:39:50 至 21:41:01。
- 两次 `npm ci --ignore-scripts` 成功；216 项测试通过，0 失败、0 跳过。
- Helper 4.9.5、EJS 1.17.9 的实际下载 SHA-256 与锁定值一致。
- 打包 593 个明确选择的 public 源文件及两插件，最终 742 项静态资源。
- Linux runner 的 Worker dry-run：651.64 KiB，gzip 125.75 KiB。
- 部署选择检查和实际更新实例步骤均为 `skipped`，artifact 数量为 0。
- 仓库仍为私有，仅启用 STWorkers 手动工作流；上游自动发布、定时及 Issue/PR 工作流不运行。

这证明“准备插件、打包、dry-run”已离开开发电脑在 GitHub 上完成，
不是完整“一键首次部署”、真实 Cloudflare 更新、免费额度或完整社区卡验收。
后续授权配置受限 Cloudflare Token 后，才测试更新已有个人实例；
不需要将登录密码、`DATA_KEY` 或模型 Key 交给 GitHub。

### 清单版本托管验证

2026-09-11，经所有者授权，推送清单改造提交
`91c9d4c1e2816e263fb068a92777de0ddf3ea3ca`，
只触发一次 [Actions #2](https://github.com/begonia599/STWorkers/actions/runs/34614224428)，
attempt 1，结论 `success`。

- 输入：`deploy=false`、`update_plugins=false`，保持两款插件已有版本。
- 环境：Ubuntu 24.04、Node 22.14.0；任务于北京时间 23:07:22 至 23:08:36 运行，约 74 秒。
- 247 项测试通过，0 失败、0 跳过；两份真实归档的 SHA-256 与锁文件一致。
- 593 项明确选择的 public 源文件、两插件，最终 742 项资源；Wrangler dry-run 通过，
  Worker 为 652.28 KiB，gzip 125.87 KiB。这里不是实际上传。
- 默认分支锁步骤使用内置临时凭据成功，日志确认锁文件未变、不需要仓库提交。
- 部署选择检查与实际部署步骤均跳过，artifact 数量为 0。
- 完成后核对仓库仍为私有，总运行数为 2，默认分支仍停在测试提交，
  工作流未生成新提交。随后仅更新验证文档，不新增 Actions 运行。

这次证明真实 GitHub 构建及锁文件无变化路径可用，不证明有变化时的 Git 写入、
主动升级插件、Cloudflare 部署或完整首次授权初始化已经通过。

参考官方文档：

- Cloudflare Workers / CI & CD / GitHub Actions。
- GitHub Actions / Manually running a workflow、Workflow syntax、Secure use。
- 固定版本 Wrangler 的 required secrets 继承实现与本地 dry-run。
