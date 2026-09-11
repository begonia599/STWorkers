# 首次 Cloudflare 测试

本流程只面向所有者自己的独立测试实例，不是公开发行或 P5 完成声明。
本地灯塔卡固定回复对照已通过，真实模型自主填表、真实 Workers 行为和免费资源消耗仍待验收。
不要导入唯一一份个人资料，不要把测试实例开放给其他用户。

## 当前工作区状态

2026-09-10 用户已明确授权，本工作区的独立测试实例已部署。
URL、版本 ID、D1/R2 标识和本轮核验状态保存在
`cloudflare/.deploy/stworks-cloud-test/deployment.json`，不写进公共源码。
本实例已经创建资源并完成迁移，不要重复执行下文的创建命令。

登录名 `owner`；登录密码取同目录 `secrets.json` 的 `AUTH_PASSWORD`。
这是 STWorkers 的独立登录，不是 Cloudflare 邮箱/密码；不要更改 `DATA_KEY`。
首次进入会显示原版欢迎向导，里面的人设名称与 HTTP 登录用户名是不同概念。
当前源码直接使用原版界面中的 HTTPS 模型地址与密钥，不再要求域名白名单。
2026-09-10 用户授权后，白名单移除与连接错误提示修复已上传到同一测试实例。
更新前后各 17 项 HTTP 检查通过，没有发往真实提供商的请求或用户数据写入；
两项云端 secret 通过原绑定继承，没有重建资源、重新迁移或更换密钥。

本轮通过鉴权/CSRF、基础 D1/R2 往返和桌面/手机首屏，没有调用真实模型。
首次页面启动约 41/27 秒，仍需后续性能验证。完整灯塔云端生成、分支/MVU 和费用验收未关闭。
未进行订阅、升级或付费附加功能操作；账户 Workers 用量模型为 `standard`，
但订阅 API 因 OAuth 权限不足返回 403，不能将用量模型或部署成功等同于确认了 Free 套餐。
R2 已核实为 Standard、公共管理域名关闭、无公开自定义域名。

## 1. 仅本地准备

在项目根目录执行：

```powershell
node cloudflare/scripts/setup-cloud.mjs --with-p3-plugins
node cloudflare/scripts/check-cloud.mjs --draft
```

也提供 `setup:cloud` / `check:cloud` npm 脚本。
PowerShell 的 `npm.ps1` 在本机实测会吞掉上述转发参数；使用这里的直接 Node 命令，
或显式使用 `npm.cmd --prefix cloudflare run setup:cloud -- --with-p3-plugins`。

默认实例名 `stworks-cloud-test`，输出：

- `cloudflare/.deploy/stworks-cloud-test/wrangler.json`：独立配置。
- `cloudflare/.deploy/stworks-cloud-test/secrets.json`：新生成的登录密码和数据加密密钥。
- D1 名称固定为 `stworks-cloud-test-db`，R2 名称为 `stworks-cloud-test-files`。

`.deploy/` 被 Git 忽略，也不在静态资源目录或 `.build/` 中。
工具不读取 `.dev.vars`，不登录、不下载、不创建远端资源、不迁移数据库、不上传。
生成的 JSON 没有 Cloudflare API Token 或模型凭据。账号和数据库 ID 未知时明确保留占位符。
`--draft` 允许这些占位符，并明确报告 `draft-only-resource-ids-required`；正常检查会拒绝它们。

可用参数：`--name`、`--account-id`、`--database-id`；模型地址不在部署初始化中设置。
不带 `--with-p3-plugins` 时选择无第三方插件的普通构建。
每个名称只初始化一次；重复运行验证并保留原文件，参数冲突或文件损坏会失败。
不要为了重新运行准备脚本删除密钥文件。丢失或更换已使用的 `DATA_KEY` 会使旧模型凭据无法解密。
文件创建使用 `0600`，但 Windows 仍依赖目录 ACL；Git 忽略不是加密，也不能防止云盘或备份共享。

带插件检查要求已经存在显式选择的 P3 构建，不能误用普通 `npm run build` 的无插件输出。
没有构建时按 `P3-CONTRACTS.md` 准备锁定的公开归档，再执行：

```powershell
node cloudflare/scripts/prepare-p3-plugins.mjs <指定公开归档的目录>
node cloudflare/scripts/build-assets.mjs --plugins <上一步生成的-bundle.json-绝对路径>
```

没有隐式安装第三方插件。保留其许可和源码归档，不代表再分发许可审查已通过。
插件仍有浮动 CDN 依赖；本地依赖缓存重放通过不代表云端浏览器一定能访问它们。

## 2. 账号与费用确认

以下操作必须在所有者明确授权后进行，本地准备工具不会执行：

1. 所有者登录自己的 Cloudflare 账号，确认账号 ID，不使用公共账号或其他项目的数据库/存储桶。
2. 确认 Workers 套餐，查看 D1/R2 现有用量与开通提示。
3. 如 R2 开通要求订阅或付款资料，由所有者阅读并决定；不能替用户同意或承诺绝不收费。
4. R2 的免费额度不等于自动零费用上限。记录控制台显示的额度、用量和计费条件，拒绝未经同意的套餐变更。
5. 模型调用费用单独计算。先做不调用模型的测试，再由所有者配置提供商并授权少量真实请求。

所有静态资源先经过 Worker 鉴权，不能按“纯静态直出”假设它们不消耗 Worker 请求。
离线检查覆盖当前 Free 计划的 20,000 个静态文件、每文件 25 MiB 边界；
这不验证账号余量、CPU、D1/R2 请求和存储配额，也不保证长期免费。
Worker 压缩包大小另由 dry-run 记录；真实 CPU、延迟和取消传播只能在云端测试。

## 3. 手动创建独立资源

下面是授权后的操作手册，**不是让准备脚本自动执行**。
示例均在 `E:\STworks\cloudflare` 执行，使用本项目已安装的锁定 Wrangler，避免临时下载新版本：

```powershell
node node_modules/wrangler/bin/wrangler.js login
node node_modules/wrangler/bin/wrangler.js whoami
```

在独立 `wrangler.json` 填入该账号的 `account_id`，然后创建两个新测试资源：

```powershell
node node_modules/wrangler/bin/wrangler.js d1 create stworks-cloud-test-db --config .deploy/stworks-cloud-test/wrangler.json --update-config=false
node node_modules/wrangler/bin/wrangler.js r2 bucket create stworks-cloud-test-files --config .deploy/stworks-cloud-test/wrangler.json --update-config=false
```

若名称已存在，先核对其所有权和用途，不覆盖、不复用来源不明的资源。
保持 R2 私有，不开启 `r2.dev` 或公开自定义域名。
将新建 D1 返回的 UUID 填入独立配置的 `d1_databases[0].database_id`，不要修改原 `cloudflare/wrangler.jsonc`。
确认数据库名和桶名未改变；生成配置的 `DB`、`FILES` 是应用绑定名，不是账号里的资源 ID。

不需要设置模型域名白名单。部署后在原版界面填写自己信任的完整 HTTPS API base URL、
模型 ID 和 API Key；URL 可包含 `/v1` 等路径，但不能嵌入密码、查询参数或 fragment。
密钥在界面中保存，不填进普通 `vars`。更换模型服务不要求重新部署。
旧版本残留的 `MODEL_ALLOWED_ORIGINS` 变量在新代码中被忽略，
现有配置仍可通过离线预检，不需要为它重新初始化资源或密钥。

## 4. 检查、迁移与首次上传

仍在 `cloudflare` 目录。先做正常离线检查，再做不上传的构建：

```powershell
npm run check:cloud
node node_modules/wrangler/bin/wrangler.js deploy --config .deploy/stworks-cloud-test/wrangler.json --secrets-file .deploy/stworks-cloud-test/secrets.json --dry-run --outdir .build/cloud-test-worker
```

正常检查只表示本地配置、密钥格式和资源清单通过，不表示远端资源存在或配额充足。
它拒绝额外部署钩子、其他绑定、静态路由绕过、明文密钥变量和不匹配的插件清单。
文件数/总字节核对不是所有资源的密码学完整性证明；插件初始归档仍由原打包器验证。
基线 `wrangler.jsonc` 当前是合法 JSON；如将来加入 JSONC 注释，需要同步升级读取器。

再次核对账号与新建 D1 的 ID，**以下两条才会修改云端**：

```powershell
node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote --config .deploy/stworks-cloud-test/wrangler.json
node node_modules/wrangler/bin/wrangler.js deploy --config .deploy/stworks-cloud-test/wrangler.json --secrets-file .deploy/stworks-cloud-test/secrets.json --strict --x-auto-create=false
```

迁移必须先成功，再上传。不要把 `--remote` 用到原本地配置。
首次上传通过 `--secrets-file` 同时携带 `AUTH_PASSWORD` 与 `DATA_KEY`，不先裸部署再补密码。
配置也声明这两个必需 secret；服务端缺少有效登录密码时保持拒绝服务。
`--x-auto-create=false` 关闭自动创建，但 Wrangler 仍可能提示交互式创建；出现额外资源/替换提示就中止并核对。
`--strict` 的冲突检查不能替代正确账号选择或所有者授权。
不要将密码粘贴到命令行参数、聊天或截图中。

### 已有实例更新

仅在所有者明确授权后，核实当前版本、DB/FILES 绑定和两项必需 secret 仍存在，
完成测试、相应资源构建及离线预检，再更新同一个 Worker：

```powershell
node node_modules/wrangler/bin/wrangler.js deployments status --config .deploy/stworks-cloud-test/wrangler.json
node node_modules/wrangler/bin/wrangler.js deploy --config .deploy/stworks-cloud-test/wrangler.json --strict --x-auto-create=false
```

已有实例的这条更新命令不带 `--secrets-file`，由 `secrets.required` 继承远端原绑定；
缺少必需 secret 时应失败，不得重新生成 `DATA_KEY` 来解决。不要重新执行资源创建命令。
本次没有新增迁移，不重复迁移 D1。上传成功后仍须检查实际部署版本及带鉴权的 HTTPS 响应。

## 5. 云端验收清单

部署后仅使用 Wrangler 实际返回的 HTTPS 地址，不猜测账号的 workers.dev 子域名。
登录名为 `owner`，密码来自本实例的私密 `secrets.json`，不是 `.dev.vars` 的本地密码。

- [ ] 未登录访问首页、`/lib.js`、`/__stworks/bootstrap.json`、插件入口和数据 API，均返回 401。
- [ ] 登录后首页可启动；`/api/stworks/status` 可读，仍显示当前未全面验收状态。
- [ ] 跨来源写入和缺少 CSRF 的请求拒绝，错误中不包含任何密钥。
- [ ] 导入灯塔 v1.1 测试卡并**新开聊天**，初值、状态栏与两插件入口正常。
- [ ] 世界书、预设、正则、角色卡和聊天可保存；新浏览器会话能恢复。
- [ ] R2 头像经过鉴权；卡片/聊天导出再导入保留未知字段、变量和分支。
- [ ] 配置真实提供商，以低输出上限验证非流式、流式、首包前停止、停顿流停止和失败后手动重试。
- [ ] 完成灯塔 T/N 的真实模型自主填表；区分模型未遵守规则、卡逻辑问题与 Workers 适配问题。
- [ ] 重生成、左右分支切换、手机重载后发送，变量与状态栏一致。
- [ ] 记录第三方 CDN 成功/失败，不以本地缓存重放代替线上可达性。
- [ ] 记录桌面/手机首屏请求数、延迟、Worker CPU/错误、D1/R2 请求与存储用量。
- [ ] 记录构建清单、插件提交、迁移结果和测试日期；证据不包含密码、模型 key 或完整私人提示词。

测试失败时先保留脱敏证据，不自动重试生成、不自动重建存储、不更换加密密钥。
升级前导出测试资料并备份密钥；当前完整备份/恢复工具尚未验收。
不使用一键删除账号资源的清理脚本。清理需再次确认三个确切测试资源名，并由所有者授权。

## 6. 连接模型失败

先在浏览器开发者工具的 Network 中选择 `/api/backends/chat-completions/status`，
只查看 Response 的 `error.code` 和 `error.message`。不要分享请求头、完整 HAR、
模型密钥或可能含有凭据的请求体。

- `MODEL_ORIGIN_NOT_ALLOWED`：说明请求仍到达白名单移除之前的旧版 Worker。
  应由所有者授权更新已部署的代码，不要让用户补填白名单，也不要重建 D1/R2 或更换密钥。
- `INVALID_MODEL_URL`：检查是否填写了提供商的最终 HTTPS API base URL；
  不能填本站、IP、本地地址或在 URL 中嵌入凭据。
- `INVALID_CSRF_TOKEN`：刷新页面后重试；不要通过关闭 CSRF 来修复。
- `CROSS_ORIGIN_WRITE`：确认从实例自己的正式地址打开页面，不通过其他站点转发写请求。
- `MODEL_UPSTREAM_ERROR`：请求已到达提供商；403 表示提供商拒绝访问，
  需检查该提供商的凭据、权限和服务限制，不能当成白名单问题。

当前实现支持 OpenAI 和 Custom（OpenAI-compatible）；其他原版来源入口不表示已完成后端适配。
2026-09-10 的本地修复会显示 HTTP 状态及结构化错误，并阻止地址/CSRF 等错误仍显示为
“跳过状态检查”。修复已上传；线上脚本与本地测试源码的 SHA-256 一致。
更新验证没有使用所有者实际模型凭据，也没有验证某个真实提供商一定可连接。
仅凭控制台的 403 不能确定上述哪一种原因，需要响应中的错误码。

## 参考依据

2026-09-10 核对项目锁定的 Wrangler 4.129.1 参数、schema 与必需密钥验证源码；
同时核对 Cloudflare 官方文档的静态资源限制和配置方式。实际账号开通与费用仍未实测。

- [Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/)
- [部署密钥](https://developers.cloudflare.com/workers/configuration/secrets/)
- [静态资源限制](https://developers.cloudflare.com/workers/static-assets/platform/limits/)
- [Worker 优先路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 开始使用](https://developers.cloudflare.com/r2/get-started/)
- [R2 定价](https://developers.cloudflare.com/r2/pricing/)
