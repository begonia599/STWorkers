# P1 接口与验收边界

日期：2026-09-08。阶段为 `P1-in-progress`，不是完整兼容版本。

## 已接入的请求

除下表明确标记 GET 外，均为 POST。读写都先鉴权；写请求需要 CSRF。
方法不符返回 405，未知 API 返回 501，不返回前端页面或伪造成功。

| 接口 | 当前契约 |
| --- | --- |
| GET `/version` | ST 1.18.0 的兼容身份；独立 stworks 阶段字段，不伪造远端 Git 状态 |
| GET `/api/extensions/discover` | 实际打包的系统扩展 regex、quick-reply |
| `/api/settings/get`, `/save` | settings 保持 JSON 字符串包裹，预设数据与名称数组一一对应 |
| `/api/presets/save`, `/delete`, `/restore` | 默认预设覆盖、删除标记、读取原始默认值；未知字段保留 |
| `/api/worldinfo/list`, `/get`, `/edit`, `/import`, `/delete` | 世界书名称及扩展字段；JSON multipart 导入 |
| `/api/quick-replies/save`, `/delete` | 实际持久化，不只返回成功 |
| `/api/characters/all`, `/get`, `/create`, `/edit` | 角色目录、默认 PNG、原版表单字段与头像替换；裁剪由浏览器执行 |
| `/api/characters/import`, `/export` | PNG/JSON；file_name 不含 .png；preserved_name 显式覆盖，保留聊天关联 |
| `/api/characters/rename` | 返回新 avatar；角色与全部聊天索引在同一 SQL 语句中迁移 |
| `/api/characters/edit-avatar` | 仅替换 PNG 头像，不改角色字段、当前聊天或扩展数据 |
| `/api/characters/duplicate`, `/delete` | 单角色复制；只有 delete_chats=true 时删除关联聊天 |
| `/api/characters/edit-attribute`, `/merge-attributes` | 单角色字段修改；null 是值，显式 UNSET sentinel 才删除字段 |
| GET `/characters/...`, `/User%20Avatars/...`, `/thumbnail` | 私有角色/人设图片与默认背景；当前没有独立缩略图缓存 |
| `/api/characters/chats`, `/api/chats/recent` | 聊天索引、预览、元数据 |
| `/api/chats/get`, `/save`, `/export`, `/delete` | 原版 JSON 数组请求；R2 内 JSONL 快照，保留 header/message/swipe/variables |
| `/api/chats/import` | multipart 原生 ST JSONL；完整校验后保存，返回 `{res:true,fileNames:[含扩展名的文件名]}` |
| `/api/chats/rename` | `original_file` / `renamed_file`；原子改名，返回 `ok` 与不含扩展名的 `sanitizedFileName` |
| `/api/chats/search` | 管理聊天窗口的列表和搜索；返回不含扩展名的 `file_name`、`message_count`、`preview_message` 等 |
| `/api/secrets/settings`, `/read`, `/write`, `/delete`, `/rotate`, `/rename` | 独立 AES-GCM 密钥，前端只见脱敏条目；无 id 删除当前 active 条目 |
| `/api/secrets/view`, `/find` | 明文读取明确 403 |
| `/api/avatars/get`, `/upload`, `/delete` | 默认头像与私有 R2 头像；overwrite_name 覆盖；删除保留索引墓碑 |
| `/api/backgrounds/all`, `/folders` | 默认资源列表；自定义背景上传和目录管理未接入 |
| `/api/image-metadata/all` | 读取可选元数据索引；没有生成颜色等元数据时返回空索引 |
| `/api/groups/all` | 读取实际 group 文档；当前没有创建接口，空实例返回空列表 |
| `/api/stats/get`, `/update` | 持久化前端统计；服务端重建统计未实现 |
| `/api/files/sanitize-filename` | 复用原版 sanitize-filename，支持世界书等导入流程 |

## 本轮观察到的原版启动顺序

`csrf-token`、`version`、`secrets/read`、`settings/get`、`extensions/discover`、
quick-reply 再次读取 `settings/get`、`avatars/get`、`characters/all`、`groups/all`、
`backgrounds/all`、`backgrounds/folders`、`image-metadata/all`、`chats/recent`。
`secrets/settings`、stats 等入口按 UI 操作额外触发。

首次运行保留原版用户名引导。新默认配置从 AI Horde 改为聊天补全，只影响未保存设置的实例。
已有用户选择 Horde 的配置不会被改写；对应后端尚未实现，仍可能报错。

从列表选择角色后，`chats/get`、必要时 `chats/save`、`avatars/get`、Token 计数等继续触发。
计数现在通过原版前端函数在浏览器估算，不再请求后端分词接口。
角色和展开后的世界书条目可显示估算值，测试未出现 counting 卡住或计数异常。
当前算法只使用 UTF-8 字节数回退及消息开销估算，不代表真实模型 Token 数。

## 临时 Token 契约

- 按用户本轮确认，先使用可替换的前端估算，待朋友的方案发布后评估接入。
- 独立算法文件为 `public/scripts/stworks-token-estimator.js`，无词表或 WASM 依赖。
- 保留 `getTokenCount` / `getTokenCountAsync`、`countTokensOpenAI` / `countTokensOpenAIAsync`、
  `guesstimate` 的同步/异步返回方式；原版 padding 流程继续保留，空消息估算返回 0。
- 算法 id 区分缓存版本；`tokenEstimator` 导出与状态接口明确 browser / estimate / tokenIds=false。
- Token ID 编解码、直接调用 `/api/tokenizers/*` 的脚本不在这次通过范围，旧 HTTP API 仍 501。
- 不能用文字估算代替图片/音频计费或上下文上限保证；生成阶段需验证预算余量和超限错误。
- 这不是酒馆助手兼容证明；涉及真实 Token ID 的社区功能须单独验证与实现。

## 数据和并发

- D1 文档/普通 JSON 请求限制 1 MiB；一般 multipart 总请求 8 MiB；
  聊天导入 multipart 总请求、聊天保存请求及保存后的完整快照均限制为 16 MiB。
- 已测试超过 1 MiB 的聊天正文存于 R2，而不是塞入一个 D1 文档。
- 仍保存完整快照，不是真正的分块或增量保存。聊天元数据索引依旧受 1 MiB 限制。
- 保留最新和上一版聊天快照；较老快照清理失败在后续保存重试。
- 模拟 R2 写入失败、D1 重叠写冲突和清理失败，已验证旧数据不被对应失败覆盖。
- 原版不发 If-Match；服务器读取之后重叠的更新可冲突，但陈旧的顺序保存仍覆盖新数据。
- 这不是跨 D1/R2 事务。崩溃后的孤立对象回收、恢复工具、多记录删除竞争仍是发布阻碍。
- 世界书、角色卡未知扩展字段按对象保存；完整格式兼容还需原版差异回归。

## 头像与角色管理

- 新模块 `public/scripts/stworks-avatar.js` 在浏览器解码、裁剪和编码 PNG；
  `script.js`、`personas.js`、`slash-commands.js` 只在原版上传入口增加适配，
  没有全局替换 fetch，也没有重写裁剪框或人设页面。
- 原版默认裁剪尺寸仍为 512x768；不裁剪时保留原图尺寸。浏览器图片重采样不承诺逐像素等同 Jimp。
  本地已验证 JPEG 上传后的裁剪区域、尺寸和颜色，及 PNG 导入/读取；其他格式、动画和 EXIF 仍需专项验证。
- 输入限制 8 MiB；浏览器输出 PNG 最多 7 MiB，为表单和卡片字段保留空间；
  单边最多 8192、总像素最多 16,777,216。整个 multipart 仍受 8 MiB 限制。
- Worker 不部署图片解码/缩放引擎，只校验 PNG 结构和尺寸。原始 `?crop=` 请求明确返回
  422 `CLIENT_IMAGE_PROCESSING_REQUIRED`；直接调用 API 的扩展需发送已经处理好的 PNG。
  这条边界必须纳入酒馆助手实际脚本验收，不能把原版 UI 通过当作所有调用方兼容。
- 头像替换先写新对象，D1 通过版本检查提交指针后再清理旧对象；失败不覆盖旧指针。
  已提交的旧图清理失败保留 garbage 引用，下次替换重试；崩溃回收和最终删除后的后台清理仍待做。
- 人设名称、描述及扩展字段继续由原版设置保存；上传/替换不会替换整份人设设置。
  默认头像可覆盖或删除；删除墓碑阻止再次从静态资源回退显示已删除头像。
- 覆盖导入必须显式给出 preserved_name；普通导入仍分配新文件名。
  整份卡片内容被新卡替换，旧脚本不会被合并回来；新卡的未知字段保留。
  当前聊天选择、已有聊天、角色创建时间保留；JSON 覆盖使用默认头像，PNG 覆盖使用新卡图片。
- 角色改名依赖增量迁移 `0002_character_chat_links.sql`；升级或启动前必须应用迁移。
  触发器在同一语句内移动角色与聊天索引，保留快照、变量、上一版本指针及聊天时间，不复制 R2 正文。
  目标已有遗留聊天、陈旧修订或并发改名返回 409；新聊天上传过程中角色改名/删除也会阻止旧名落盘。
- 本地 D1 的 changes 包含触发器写入。成功判断和测试替身已对齐，避免提交成功却误报 409。
  删除后同名重建、跨记录删除和过时客户端顺序写入问题仍未因此全部解决。

## 聊天迁移边界

- 原生 JSONL 接受 UTF-8 BOM、CRLF、空白行、尾换行和只有聊天头的空聊天；
  所有消息必须是对象并含文本 `mes`，任意坏行使整次导入失败，不落半份数据。
- 保留头部字段、聊天变量、swipes、swipe_info、消息变量和未知字段；重复导入分配不同文件名。
- 原版前端保存时，未再次提交的聊天头字段会保留；显式提交的字段整体覆盖，null 也是值。
  头字段不能通过省略来删除，聊天元数据中的变量删除仍按前端提交的完整对象生效。
- 原子改名不复制正文；已存在的目标或版本冲突返回 409，避免覆盖目标。
  正在上传旧名快照的保存、已读到旧版本的删除，与改名冲突时失败，不破坏改名后的正文。
- 改名后首次读取旧名仍返回空数组，符合现有 get 契约；过时客户端后来新发起的无版本保存、
  跨记录删除和重新创建问题没有因此全部解决。
- 当前其他 JSON 导入格式返回 415，非原生 JSONL 返回校验错误，群聊仍 501。
- 列表空查询不读取聊天正文。全文搜索扫描上限为 32 个对象/16 MiB，超限 422；
  尚不是大规模聊天检索方案，免费资源性能未实测。

## 仍未完成

真实 Token ID 编解码、生成与取消、其他聊天导入格式、角色批量编辑、
角色关联世界书的嵌入导出细节、群聊、
附件/自定义背景、主题等额外保存接口、备份恢复与插件安装更新。
当前 PNG/JSON 之外的卡格式明确拒绝；不是宣称所有 V1/V2/V3 或社区卡用例都已通过。

内置正则的加载和普通开场白宏展开不代表提示词链路验收。
酒馆助手、EJS、MVU 和真实社区卡均未运行验证；不降低这些发布门槛。
本项目始终不考虑本地模型管理、服务端推理、语音、生图。

## 验证入口

- `npm --prefix cloudflare test`：96 项测试，D1 使用内存 SQLite，R2 使用故障可控的测试替身。
- `npm --prefix cloudflare run test:storage-local`：默认 8789，真实本地 Wrangler D1/R2 冒烟。
- `cloudflare/scripts/check-p1-browser.mjs`：重新选择本轮手动通过原版 UI 导入的合成样例，
  断言角色描述、开场白、世界书、预设与扩展字段恢复，前端同步/异步估算、角色/世界书计数，
  并要求零后端计数请求、无 HTTP 错误或未处理页面异常；需要该测试实例和 Playwright。
  第一个参数可传包含 Playwright 的 package.json 绝对路径，第二个参数可传浏览器可执行文件。
- 浏览器证据：`cloudflare/.build/p1-browser/report.json`、`desktop.png`、`mobile.png`。
  输出明确记录 `fullFrontendAcceptance: false`，不会把存储通过误报成完整启动或插件兼容。
- `cloudflare/scripts/check-chat-transfer-browser.mjs`：同样的 Playwright 参数；
  创建唯一命名的合成角色，经原版控件导入 JSONL、打开、改名、保存，再从全新手机上下文重载，
  验证头字段、变量和 swipe 数据。结束后清理该角色及其聊天，仅运行于 8789 隔离实例。
  证据位于 `cloudflare/.build/chat-transfer-browser/`，不代表生成和第三方插件通过。
- `cloudflare/scripts/check-character-management-browser.mjs`：同样的 Playwright 参数；
  经原版控件执行角色头像裁剪、取消后再保存、改名、覆盖导入、人设上传/替换/删除和新手机上下文重载。
  检查实际解码像素、尺寸、聊天变量、回复分支及人设未知字段。只运行于 8789，清理合成数据并恢复测试设置。
  证据位于 `cloudflare/.build/character-management-browser/`，包含 report.json 与桌面/手机截图。
