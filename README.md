# STWorkers

复用 SillyTavern 原版前端，面向每位用户自己的 Cloudflare 账号部署。

## 版本说明

**本次公开发布的是 STWorkers 最低限度核心功能部署测试版，不是稳定版，也不代表项目的最终形态。**

本阶段围绕原版界面、角色卡、预设、正则、宏、世界书和基本聊天，验证核心功能在 Cloudflare Workers
上的部署与使用，并收集酒馆助手、EJS 和社区角色卡的实际兼容性反馈。
当前的功能范围、性能表现和部署体验只代表这一阶段；现有缺失不等于最终取舍，
后续会在[已冻结的目标](docs/GOALS.md)范围内继续补齐核心能力、改善兼容性并优化部署和使用体验。

**欢迎提出当前版本的功能缺失、遗留问题和改进建议。** 请通过下方[问题反馈](#问题反馈)提交。
开放部署测试不表示完整 ST 功能、全部插件或所有云端场景已经通过验收；具体证据和待办仍单独保留。

## 部署测试版

请使用全新资源和非重要测试资料，保留原始资料的独立备份。

1. **准备 Cloudflare 账号。** 先注册并登录自己的 Cloudflare 账号；注册过程不在本教程中演示。
2. **先开通 R2。** 在 Cloudflare 控制台搜索 `R2`，进入「R2 对象存储」。
   初次开通时，按页面提示绑定支付方式并完成 R2 开通确认；已经开通的账号可跳过。
   此时无需手动创建存储桶，项目所需的新资源在后面的部署流程中配置。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/begonia599/STWorkers)

3. **回到 GitHub 仓库，点击上方 Deploy to Cloudflare 按钮。** 按页面指引授权自己的 GitHub/GitLab 账号，
   设置新副本名称，例如仓库 `STWorkers-button-test`、Worker `stworkers-button-test`；
   D1 和 R2 也使用新资源，不选择已有实例或其数据库。
4. **填写变量参数。** 自行设置非空的登录密码 `AUTH_PASSWORD`，没有 24 字符要求，也不是模型 API Key。
   `DATA_KEY` 由首次部署自动生成，不需要自行填写。其余构建参数保持默认：
   根目录为仓库根目录，构建命令 `npm run build`，部署命令 `npm run deploy`。
5. **点击部署并等待完成。** 成功后打开平台给出的地址，在原版登录页选择 `owner`，首次密码为上一步设置的值。
   登录后可在原版「账户」面板修改日常密码；不再使用浏览器 Basic 弹窗。

**支付说明：** 绑定支付方式用于 Cloudflare 的验证及 R2 计费开通，不是向本项目付款。
R2 可从免费月度额度开始使用，但 Cloudflare 可能进行临时预授权；预授权不等于正式扣款。
超出 R2 标准存储免费额度仍会按量计费，不承诺无限免费。详见[开通与费用说明](docs/NATIVE-DEPLOY.md#r2-开通与费用)。

默认预装酒馆助手和 EJS，可在自己的仓库编辑 `plugins.txt`。
首次构建 Token 权限、资源预配、密钥初始化的真实平台结果仍待验证；失败时保留资源和构建日志，
不要删除数据库或重新生成 `DATA_KEY` 来绕过报错。报告问题时请遮住密码、Token 和模型 Key。
当前自动生成密钥的备份/恢复入口未完成；遇到套餐升级或计费确认页面，应先核实再继续。
详细范围和失败处理见 [原生部署说明](docs/NATIVE-DEPLOY.md)。

账号迁移与恢复见 [账号说明](docs/ACCOUNT-AUTH.md)。旧实例更新必须先应用新增的 D1 迁移，
保留原来的 `AUTH_PASSWORD` 和 `DATA_KEY`；账号改造的云端验证与旧版云端测试结果分开记录。

## 问题反馈

发现功能缺失、部署或登录失败、插件/角色卡不兼容，以及其他遗留问题，
都欢迎在 [STWorkers Issues](https://github.com/begonia599/STWorkers/issues) 提出，支持中文反馈。
可以使用「问题反馈」或「功能缺失与建议」模板，不必先确定原因，也不要求先关闭所有插件。

请尽量提供以下信息；不清楚的项目可以留空：

- 使用环境：手机或电脑、浏览器，以及 Cloudflare 按钮部署或其他部署方式。
- 问题现象：操作步骤、预期结果与实际结果；功能建议请说明遇到的使用场景。
- 相关版本：STWorkers 提交或部署时间；涉及插件、角色卡时补充名称、版本和最小复现样例。
- 脱敏证据：报错截图、构建日志或浏览器错误；如已对照原版 ST，可附上差异，不是提交前提。

**不要公开密码、Token、模型 API Key、`DATA_KEY`、Cookie 或私人聊天内容。**
仅在有权分享且已脱敏时提供角色卡和其他附件。提交建议不等于承诺全部采纳；
本地模型管理、服务端推理、语音、生图及公共多租户服务仍不在项目范围内。

## 当前状态

**当前推进随包发布与首次部署入口，P1/P2/P3/P4 的剩余门槛继续保留：酒馆助手 4.9.5 与 EJS 1.17.9 的本地合成回归、
流式/停止/重生成的独立原版对照通过。
灯塔 smoke 卡及 card2 v1.1 的真实 MVU、固定回复对照已有本地证据。
已部署所有者的独立云端测试实例，鉴权、基础 D1/R2 存储及桌面/手机首屏通过。
完整 P1/P2/P3、其他社区卡、真实模型自主填表和完整云端验收仍未通过。**

## 已冻结的目标

- 以 Cloudflare 免费资源额度为设计边界，不依赖常驻服务器或付费计算。
- 保留原版界面、操作习惯、预设、正则、宏、世界书、角色卡和基本聊天。
- 将酒馆助手、ST-Prompt-Template 以及实际社区角色卡的兼容性作为发布门槛。
- 保留在线安装、更新插件的产品方向，改造底层实现，不永久锁死插件版本。
- 不考虑本地模型管理、服务端推理、语音、生图。
- 不实现公共注册、多租户托管平台；每个实例默认只有一个所有者。

完整约束见 [目标冻结](docs/GOALS.md)，推进顺序见 [路线图](docs/ROADMAP.md)。

## 当前部署路线

沿用测试版最初的随包预装方式，把“准备插件、打包、部署”交给构建平台。
**GitHub Actions** 已通过托管构建，**Cloudflare Workers Builds 原生首次入口**已完成本地原型验证；
两者复用同一套插件清单和打包逻辑。Worker 在线安装的性能优化留待后续细化。

Actions 工作流默认只构建验证，显式勾选后才更新已有个人实例，继承现有密钥和 D1/R2 绑定。
不要求把登录密码、`DATA_KEY` 或模型 API Key 传给 GitHub。
2026-09-11 已推送到私有仓库，并通过第 1 次真实 GitHub Actions 构建：
216 项测试、两插件固定归档下载、742 项资源打包及 dry-run 均成功。
本次未勾选部署，未通过 Actions 更新云端；从零创建资源和初始化密钥仍不包含在内。

使用入口与配置见 [GitHub Actions 预装发布](docs/GITHUB-ACTIONS.md)。

### 预装插件清单

现在支持根目录 [plugins.txt](plugins.txt)：一行一个公开 GitHub 插件仓库地址。
默认酒馆助手和 EJS 不必修改；新增插件只需加一行，再运行构建。
具体提交与归档哈希由 [plugins.lock.json](plugins.lock.json) 保存，普通重建不自动升级；
工作流新增 `update_plugins` 选项供主动更新已有插件。
成功的默认分支构建会用 GitHub 自带临时凭据保存锁文件，不要求另申请 GitHub Token。

2026-09-11 清单改造已推送，并通过真实 GitHub Actions #2：247 项测试、两插件下载、
742 项资源打包及 dry-run 通过；自动凭据确认锁文件未变，没有生成额外提交。
本次 `deploy=false`、`update_plugins=false`；有变化的锁文件自动回写仍待单独验证。
Actions 部署仍需已有实例及部署凭据。
完整的“账号授权、首次自动初始化”流程仍未通过真实平台验收。
清单支持不等于所有插件兼容，纯源码分支不会被自动执行构建脚本。

### 一键部署进度

2026-09-12（北京时间）新增根目录原生入口：`wrangler.jsonc`、密码声明、构建及部署命令。
代码支持校验平台已创建的 D1/R2、执行迁移、首次空库生成并保存 `DATA_KEY`，
后续更新继承原密钥；已有数据但缺少密钥时停止，不自动重置。
插件仍从 `plugins.txt` 选择，默认酒馆助手和 EJS。原生流程将新增插件的版本锁保存在 D1，
无需为保存锁文件配置 GitHub PAT，也不修改 Git 仓库。

本地 270 项测试、真实两插件下载/打包、两套配置 dry-run、原版桌面/手机预装重载通过。
**这不是已通过验收的云端一键部署：尚未验证首次平台授权、初始化和上传。**
自动生成密钥的用户备份/恢复入口也未完成，当前只适合后续使用全新隔离实例试验，不应导入唯一的重要数据。
经所有者授权，提供公开源码和实验按钮，供实际测试首次部署；不发布预编译插件包或 GitHub Release。
首次部署、手机授权、资源开通、恢复及插件再分发许可审查仍是稳定发行前的待办。
目标操作步骤、失败处理和发布门槛见 [原生部署入口](docs/NATIVE-DEPLOY.md)。

## 项目结构

```text
public/                 原版前端，计数与头像处理已适配到浏览器
src/                    原版 Node 后端参考，不部署到 Workers
default/                原版默认数据
cloudflare/src/         Workers 兼容后端
cloudflare/migrations/  D1 数据迁移
cloudflare/scripts/     前端构建、本地初始化
cloudflare/test/        安全和数据契约测试
docs/                   目标、路线、架构和兼容性记录
plugins.txt             用户编辑的预装插件地址清单
plugins.lock.json       构建流程保存的插件提交与归档哈希
upstream-lock.json      ST 与两个插件的明确源码基线
```

原版 Docker、Colab、Replit 和本地启动/更新入口已从当前发行源码清理；
原版贡献、更新说明及安全说明集中在 `docs/`，入口见[上游参考](docs/UPSTREAM.md)。
`src/`、`server.js` 和 `webpack.config.js` 仍用于原版对照，不是 Workers 部署入口。
本地 `data/`、`backups/`、编辑器配置和原版 Node 服务端 `plugins/` 目录不纳入 Git，
不会因本次整理而清空；服务端插件目录与本项目的前端预装清单 `plugins.txt` 不同。

源码基于 ST `1.18.0`，提交 `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`。
原版 Node 后端及外围扩展暂留作参考，不表示本项目支持其全部功能。

## 本地开发

要求 Node.js 22.14 或更新的兼容版本。以下命令在项目根目录执行：

```powershell
npm ci --ignore-scripts
npm --prefix cloudflare ci
npm --prefix cloudflare test
npm --prefix cloudflare run setup:local
npm --prefix cloudflare run db:local
npm --prefix cloudflare run build
npm --prefix cloudflare run dev
```

完成初始化后，根目录的 `npm start`、`npm test`、普通本地 `npm run build` 也都指向 Workers 项目。
只有显式的 `npm run start:upstream` 才会启动用于对照的原版 Node 服务。
`npm run build:cloud` 显式构建清单预装包，本地不上传；Workers Builds 中的 `npm run build`
自动选择这条原生构建路径。根目录 `npm run deploy` 仅允许受校验的 Workers Builds `main` 生产构建，
不是现有本地实例的部署快捷命令。详见原生部署说明。

本地地址为 `http://127.0.0.1:8788`，登录用户名为 `owner`。
本地初始化会生成登录密码和独立的 `DATA_KEY`，保存在被 Git 忽略的 `cloudflare/.dev.vars`；
不会复制原 ST 的用户数据，也不会创建 Cloudflare 云端资源。
重复初始化不会覆盖已有密码或加密密钥。丢失 `DATA_KEY` 将无法解密已保存的模型凭据。

`/api/stworks/status` 展示真实阶段和兼容状态，`readyForChat` 仍为 `false`。
新实例默认选择“聊天补全”；已有用户设置不自动更改。
Token 计数先用可替换的前端临时估算，不占用后端分词请求；
真实 Token ID 编解码仍未接通；第三方插件可在新代码的原版界面在线安装，也可显式构建 P3 验证包，
不要把已列合成场景通过视为完整生态兼容验收通过。

## 当前已实现

- 所有页面与 API 的单实例访问保护；缺少密码时拒绝服务。
- 写请求的 CSRF、来源和 JSON 大小校验。
- D1 设置、预设、世界书、快捷回复及角色卡元数据。
- JSON/PNG 角色卡导入导出、基础编辑和私有 R2 头像读取。
- 角色/人设头像上传与替换，浏览器裁剪；角色改名连带聊天索引迁移，覆盖导入保留聊天关联。
- R2 聊天快照与 D1 索引，保留聊天元数据、swipe、变量和未知字段。
- 原生 JSONL 聊天导入、原子重命名、管理列表与有界全文搜索；原版保存时保留未传回的聊天头扩展字段。
- 模型凭据经 secrets API 使用独立密钥进行 AES-GCM 加密；前端只读脱敏状态。
- OpenAI/Custom 基础文本生成、模型列表、流式/非流式、停止和错误；支持自定义 YAML 参数。
- 原版文本后处理、独立 process API、受限 JSON Schema 展开与锁定版 reasoning/verbosity 参数。
- 直接使用界面填写的 HTTPS 模型地址；保留地址校验、凭据选择、请求头隔离及禁止自动重定向。
- 默认仅打包受跟踪的原版前端和明确选择的默认资源，不扫描用户数据。
- 内置正则、快捷回复真实发现；另提供经归档校验的显式 P3 插件包，保留原插件路径与编译资源。
- 原版扩展面板在线安装公开 GitHub/GitLab 插件、查询版本、更新、切换分支、卸载及上一版回退。
- 前端同步/异步 Token 估算，独立算法模块与版本化缓存；不承诺模型精确分词或计费准确。
- 对明确排除的能力返回 `410`，对未实现 API 返回 `501`。

当前本地测试及清单打包证据见 [验证记录](docs/VERIFICATION.md)。
真实本地 D1/R2 冒烟和浏览器验证覆盖合成角色卡、世界书、
预设的原版 UI 导入、角色描述编辑和重新打开后的数据恢复。
角色/世界书计数已通过浏览器估算，测试路径零后端计数请求、无 HTTP 错误或页面异常。
等待用户朋友的前端估算方案发布后再评估替换，当前不为此阻塞其他核心工作。
P1 完整验收未通过。详见 [P1 契约与缺口](docs/P1-CONTRACTS.md)。

原版聊天管理窗口已通过 JSONL 导入、打开、改名、保存和全新手机上下文重载验证。
角色改名、覆盖导入、头像裁剪，以及人设图片/资料的手机重载和删除也通过本地原版 UI 验证。
头像计算在浏览器执行；直接调用上传 API 的脚本必须发送处理好的 PNG，不接受服务端裁剪参数。
当前仅支持原生 ST JSONL；全文搜索有扫描预算，尚不承诺大规模聊天检索性能。
按用户决定，云端部署集中留到本地核心流程完成后再验收，开发期间照常做本地回归。

隔离的存储冒烟默认使用 `http://127.0.0.1:8789`：

```powershell
cd cloudflare
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/p1-test
npx wrangler dev --local --ip 127.0.0.1 --port 8789 --inspector-port 9239 --persist-to .wrangler/p1-test
# 在另一终端执行
npm run test:storage-local
```

测试只操作唯一命名的合成资料，不覆盖所有者设置；软删除记录可能留在测试数据库。
R2 目前仅在本地模拟器验证，真实免费账号的开通门槛和费用边界还未验收。

## 基础生成

原版“聊天补全”下的 OpenAI 与 Custom 基础文本链路已实现。
直接在原版界面填写提供商的完整 HTTPS API base URL（可包含 `/v1` 等路径）、
模型 ID 和 API Key；自定义服务与反向代理不需要额外域名白名单，也不需要为换服务重新部署。
密钥保存在原版 API Key 输入框，不放进部署配置或 URL。
地址须是自己信任的提供商；仍会拒绝不安全的地址格式，且不会自动跟随上游重定向。
2026-09-10 按用户决定移除白名单，并经授权更新现有云端测试实例；
云端无提供商调用探针及前端资源一致性检查通过，真实模型连接和生成仍需实际配置后验证。

本地生成验收使用合成模型，不调用真实模型：

```powershell
node cloudflare/scripts/check-generation-local.mjs <提供-playwright-的-package.json-绝对路径> <Chrome-可执行文件>
```

脚本临时使用 8790/8791 和独立 `.wrangler/p2-test`，结束后停止测试服务。
脚本还会在随机回环端口挂载锁定版原 ST 路由，比较 23 份实际出站请求体和 9 种后处理结果。
参照仅使用公开默认配置与独立空数据目录，不读取原项目私人配置或密钥。
这不是两个独立前端的完整变量/上下文对照，更不代表酒馆助手或 EJS 已经兼容。
接口限制、尚未实现的高级选项，以及它与完整 ST 对照验收的区别见
[P2 契约与缺口](docs/P2-CONTRACTS.md)。

独立双前端验收使用另一套脚本：

```powershell
node cloudflare/scripts/check-frontend-parity-local.mjs <提供-playwright-的-package.json-绝对路径> <Chrome-可执行文件>
```

临时使用 8792/8793/8794，以及每次新建的隔离测试数据目录。
原版直接从锁定提交导出干净源码，保留自身前端、Node 后端、Tokenizer、认证和 CSRF；
两边分别执行同一套操作，不复用浏览器已装配请求，也不替换原版计数。
15 个状态检查点、每边 7 份模型请求通过，覆盖变量命令、重生成、回复分支、编辑、
明确上下文裁剪、quiet/raw 客户端生成、全新手机上下文恢复与再次发送。
两种计数的临界阈值不保证相同；这仍不是酒馆助手/EJS/MVU 或真实社区卡兼容证据。
结果位于 `cloudflare/.build/frontend-parity/`。

## P3 插件验证

锁定版酒馆助手和 EJS 已在同一个原版前端、真实本地 Workers/D1/R2 中共同运行。
五类变量、非流式脚本生成、消息写入、已有回复分支、世界书/预设/全局正则编辑、
EJS 实际提示词求值、脚本 iframe 启停/事件清理及消息按钮的手机重载已通过。
新增独立原版 ST 对照：18 个检查点、两边各 18 份实际模型请求一致，
覆盖 Helper 流式/取消/并发停止、原版重生成/分支、EJS 变量递增及手机重载后发送。
不是全 API、真实社区卡、MVU 或云端兼容通过。

默认构建保持无第三方插件。按 [P3 契约](docs/P3-CONTRACTS.md) 获取明确提交的两份公开归档后：

```powershell
node cloudflare/scripts/prepare-p3-plugins.mjs <仅含指定公开归档的目录>
node cloudflare/scripts/build-assets.mjs --plugins <上条命令输出的-bundle.json-绝对路径>
node cloudflare/scripts/check-p3-local.mjs <提供-playwright-的-package.json-绝对路径> <Chrome-可执行文件>
node cloudflare/scripts/check-p3-generation-local.mjs <提供-playwright-的-package.json-绝对路径> <Chrome-可执行文件> <bundle.json-绝对路径>
```

资源输出在独立 `.build/assets-p3`，不覆盖常规 `.build/assets`。
测试临时使用 8796/8797 和每次新建的数据目录，退出时关闭测试服务。
双环境生成专项使用 8798/8799/8800，证据在 `.build/p3-generation/<uuid>`；
`latest.json` 指向最新一轮，失败轮次不会被覆盖为通过。
已修复本地流式首包等待/完整事件间停顿时的取消延迟；慢响应会先打开 SSE 通道，
此后的上游错误以明确的 SSE error 返回，不代表 HTTP 200 就生成成功。详见 P2/P3 契约。
插件 iframe 仍加载上游指定的浮动 CDN 依赖；这不是离线构建或完整外部依赖锁定。
在线安装/更新/回滚的 P4 核心接口已实现，验证进展与限制见下一节，不伪造 Git 版本。

## 在线安装插件

P4 在原版扩展面板中支持公开 GitHub/GitLab 仓库的安装、版本查询、更新、分支切换和卸载，
并增加上一版回退按钮。安装后不需要重新部署 Worker；已部署的旧测试版需先更新项目代码才有这些能力。
后端不会执行插件的 npm、构建脚本或 Git hook；只支持已有前端运行资源的插件。

下载失败或明确的并发冲突不会覆盖当前版本；卸载保留用户设置和聊天。
插件自己的前端 delete/clean hook 仍按原版运行，可能修改其设置；后端不会额外清除用户数据。
现有静态打包的两个插件也可转为在线管理，卸载后不会因静态文件仍在部署包中而重新出现。
这不是任意社区扩展、真实免费套餐性能或公开发行许可已经通过的声明。

接口和测试边界见 [P4 在线管理](docs/P4-CONTRACTS.md)。
本地实际 workerd 与原版桌面/手机专项已通过：两款锁定插件从真实 GitHub 下载、安装并加载；
合成移动分支更新、回退、手机重载、变量保留，以及卸载失败/成功两条路径通过。
不需要把插件限制为这两个仓库。私有仓库、其他托管平台和需服务端构建的插件目前不支持。
2026-09-10 经授权，既有云端测试实例已更新到 P4。两插件核心 API 和 R2 运行入口字节检查通过，
但 EJS 完整源码包下载出现超时，部分 CPU 统计桶明显偏高，免费资源门槛尚未通过。
原 bundled 插件已恢复，测试副本已清理；详见 [P4 云端记录](docs/P4-CLOUD.md)。

## 发布与许可

### 首次云端测试准备

2026-09-10 经所有者明确授权，当前工作区的测试实例已实际部署。
入口、版本与资源 ID 保存在私有本地 `cloudflare/.deploy/stworks-cloud-test/deployment.json`，
登录名为 `owner`，密码是同目录 `secrets.json` 中的 `AUTH_PASSWORD`，不是 Cloudflare 账号密码。
39 项 HTTP 请求覆盖鉴权与基础存储往返，合成资料已清理；桌面/手机欢迎页和两插件启动通过。
首次加载实测约 41/27 秒，性能仍待优化；未调用真实模型，完整生态与免费额度验收未完成。
没有更改订阅或升级套餐；Wrangler OAuth 无账单读取权限，不能据此确认套餐名称或零费用。
详细证据见 [验证记录](docs/VERIFICATION.md)。本机无需重新创建这些资源。

新增仅本地的独立测试配置和密钥初始化：

```powershell
node cloudflare/scripts/setup-cloud.mjs --with-p3-plugins
node cloudflare/scripts/check-cloud.mjs --draft
```

文件位于被 Git 忽略的 `cloudflare/.deploy/stworks-cloud-test/`。
不复制本地密码或模型凭据，重复运行不重置密钥，也不会登录、创建资源或上传。
`--draft` 允许尚未填写的账号/D1 ID；它不是可上传或云端通过的标记。
P3 模式要求已按上节生成显式插件资源；没有构建时检查会失败。
账号授权、新建独立 D1/R2、首次带密钥上传及验收清单见
[首次云端测试](docs/CLOUD-TEST.md)。实际操作账号仍需所有者明确授权。

当前没有“一键部署已完成”或“免费额度必定足够”的承诺。
模型服务由用户自行配置，模型调用费用不属于 Cloudflare 免费额度。

保留原 ST 的 AGPL-3.0 许可及署名。显式插件包保留原许可和完整源码归档；
已有所有者私有云端部署和 GitHub 托管构建记录。本次公开项目源码和实验按钮，
不发布打包后的第三方插件、构建附件或稳定版 Release；部署构建会按用户清单从上游下载插件。
酒馆助手仓库附带 AFPL v9，EJS 附带 AGPL-3.0。尤其酒馆助手再分发及组合许可关系
仍需单独审查，不能从本地运行成功推断公开发布获准。

原版说明保存在 [UPSTREAM.md](docs/UPSTREAM.md)。

本轮验证记录见 [VERIFICATION.md](docs/VERIFICATION.md)。
