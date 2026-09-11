# 架构决策

## 原版前端优先

保留 `public/`，新增 Workers 后端，不把原版 Node 服务塞入 Worker。
`src/` 仅用于接口契约及行为对照，Webpack 只在构建时使用。
前端资源构建基于 `git ls-files public`，另有明确列出的项目自有前端模块；
不扫描或上传本地用户目录。
浏览器使用的 `lib.js` 按原版 Webpack 配置的关键设置重新打包。

## 临时前端 Token 估算

2026-09-08 用户明确同意：先让计数相关流程可运行，不要求现阶段精确复刻原版分词器。
等待用户朋友的前端估算方案发布后再评估接入，不为等待该方案阻塞其他核心工作。

`public/scripts/stworks-token-estimator.js` 是唯一算法入口，当前采用原 ST 的
UTF-8 字节数 / 3.35 回退公式，消息开销也只是估算，不等于模型实际输入或计费数。
`tokenizers.js` 保留原版同步/异步导出、调用参数、前端 padding 与模型配置入口，
计数改在浏览器执行；真实 Token ID 编解码及直接访问旧后端分词 API 仍未实现。
不引入分词词表、WASM、Service Worker 或后端估算作为兜底。

缓存数据库名包含算法 id，避免沿用旧的精确计数或不同版本估算结果。
替换算法时保持同步文本/消息估算接口并升级 id；同步调整状态元数据，运行单元及浏览器测试。
若新方案只有异步入口，需要单独处理旧同步调用，不能悄悄改为 Promise。
估算误差不是上下文预算保证，生成阶段仍须处理余量和模型上下文超限错误。
UI 的 tokenizer 名称附加 browser estimate，状态接口明确 accuracy=estimate、tokenIds=false。

本地验收要求计数操作没有 `/api/tokenizers/*` 请求；这不等于整个应用没有 Worker 请求。
静态模块首次加载、鉴权、设置与聊天读写仍走现有后端。

## 后端契约

兼容范围不仅包括 URL，还包括响应格式、错误、保存时机与状态。
例如 `/api/settings/get` 中 `settings` 是序列化 JSON 字符串，
各预设目录还对应独立的数组字段。

P0 建立状态、ping、CSRF 和设置。P1 增加核心资料及聊天存储，详见 `P1-CONTRACTS.md`。
路由按具体方法和路径注册；未实现 API 返回 501，
不考虑的多媒体生成服务返回 410，不映射成 HTML 或假成功。

## 存储

P0 的 D1 不透明 JSON 文档继续用于设置、预设、世界书、角色元数据和聊天索引。
单文档与普通 JSON 请求上限为 1 MiB，multipart 上传 8 MiB，聊天保存请求 16 MiB。
这些都是项目保护值，不是 Cloudflare 平台上限，免费 CPU/内存性能尚未实测。

P1 的角色原图与完整 JSONL 聊天快照写入 R2。聊天先写新对象，再通过 D1 CAS 提交索引，
保留上一版快照，随后清理更老对象。清理失败不能把已成功提交的保存返回成失败，
正常保存路径会在后续保存重试清理。没有实现真正的分块、恢复面板、通用孤立对象回收。
跨 R2/D1 没有事务；进程终止或删除后的回收失败仍可能留下孤立对象，必须在发布前解决。

同一文档使用数据库 revision 进行比较写入。重叠写入冲突返回 409；客户端也可提交 If-Match。
原版客户端尚不携带 If-Match，因此陈旧的顺序写入仍然 last-write-wins，不是多设备冲突解决。
多记录删除和保存的竞争、删除再创建时的版本问题尚未完整处理。
每个实例独享自己的绑定和所有者，暂不引入多租户字段。

### 聊天导入与改名

原生 JSONL 导入先完成 UTF-8、聊天头和消息逐行校验，再写 R2 快照和 D1 索引。
响应保持原版 `res` / `fileNames` 契约；文件名带 UUID，重复导入不覆盖已有聊天。
聊天 multipart 总请求上限为 16 MiB，其他 multipart 仍为 8 MiB。
不把第三方 JSON 或非原生 JSONL 误判为已兼容格式。

重命名通过单条带 revision 和目标不存在条件的 D1 UPDATE 完成，不复制或删除 R2 正文。
保留快照指针、上一版本、变量、消息时间与索引更新时间；文档 revision 递增。
目标重名或源版本变化返回 409，源不存在返回 404；同名是无副作用的成功返回。
角色的当前聊天名仍由原版前端在改名成功后保存，不宣称跨角色记录的事务性。

原版保存会重建聊天头，因此更新快照时先读取旧头，再让新头显式提交的字段覆盖旧值。
未传回的扩展字段保留；显式 null 也会覆盖。`chat_metadata` 作为整体替换，
不把已删除的变量或旧分支数据合并回来。合并后的完整快照仍受 16 MiB 限制。
当前实现会多读取一次旧 R2 快照；性能与真正分块读取仍需后续优化。

`/api/chats/search` 的空查询只读取 D1 索引；非空查询按原版规则匹配文件名，
或匹配消息正文中跨消息出现的全部查询词，不搜索未选中的 swipe 或元数据。
正文扫描暂限制为 32 个对象、总计 16 MiB；超限明确返回 422，不返回截断的成功结果。
这些是本地保护值，不是免费 CPU 已满足的保证，大规模搜索仍待完善。

## 访问保护

账号后端复用原版登录页和个人资料面板，D1 保存单一 `owner` 账号及可撤销会话，替换 P0 的 Basic。
所有请求先进入 Worker；仅原版登录页的明确静态依赖、预登录 CSRF 和登录接口允许匿名。
主应用、插件、用户数据和其他 API 均需 Cookie 会话；静态资源绑定不能绕过 Worker。
线上 Cookie 使用 Secure、HttpOnly、SameSite=Strict、host-only；本地回环 HTTP 是唯一开发例外。
写入校验会话/预登录 CSRF、Origin 和 Fetch Metadata。账号支持登录限速、退出、改密和其他会话失效。
`AUTH_PASSWORD` 保留为首次登录及恢复用的 Worker Secret，日常密码在账号面板修改。
替换此 Secret 会使旧会话失效，持有新值的所有者才能恢复；不是匿名首次访问抢占账号。
数据结构、密码校验、恢复边界与验证证据见 `ACCOUNT-AUTH.md`。
P1 的 secrets API 使用独立 `DATA_KEY` 进行 AES-GCM 加密，不依赖登录密码派生。
更换登录密码不会改变数据密钥；丢失 DATA_KEY 不能恢复模型凭据。
此设计不等于任意扩展放入 settings 的敏感字段也会自动加密。

为了兼容酒馆助手，不假设 iframe 是隔离同源恶意脚本的安全边界。
不随意添加破坏 blob、srcdoc、外部模块和父窗口桥接的 CSP。
正式发布前仍需完成脚本信任提示、限额和滥用防护审查。

P0 所有响应采用 no-store；这不是最终缓存策略。
P5 需测量并优化受保护静态资源请求成本，不能假设这些请求不消耗 Worker 额度。

## 插件分发与执行

固定提交只为建立可复现的联合测试。
后续可从仓库获取版本文件，保存在对象存储并通过原路径提供，
不要求在 Worker 里运行原生 Git。
安装器与前端插件运行是不同层面，浏览器脚本不移到 Worker 执行。

## 当前配置依据

- Cloudflare Static Assets 的 `run_worker_first: true` 保证鉴权先执行。
- `html_handling: none` 保持 ST 文件路径；不使用 SPA fallback 伪装 API。
- 不使用 Containers、Sandbox、Workers AI 或任何常驻后端。
- D1 绑定保留资源名称，部署自动创建与账号流程将在 P5 实测，当前不远程部署。
- R2 `FILES` 绑定目前仅作本地模拟；未替用户开通 R2 或验证新账号的计费资料要求。
- `nodejs_compat` 用于纯 PNG 编解码依赖的 Buffer，不引入 Node 文件系统后端。

参考：

- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/
- https://developers.cloudflare.com/workers/platform/deploy-buttons/
