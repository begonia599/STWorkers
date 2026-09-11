# P3 实际插件契约与缺口

更新日期：2026-09-09。阶段为 `P3-in-progress`，`readyForChat=false`。
锁定版真实插件的首轮本地合成及独立原版生成专项回归通过，不代表完整 P3 发布门槛通过。

## 明确基线

ST 1.18.0：`8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`。

| 插件 | manifest 版本 | 提交 | 归档文件 |
| --- | --- | --- | --- |
| N0VI028/JS-Slash-Runner | 4.9.5 | `8e0f4324e7d051025a333831411f03bd3145fac8` | `helper.zip` |
| zonde306/ST-Prompt-Template | 1.17.9 | `d6f520d149aba146305b0b781ddd691d449c28d2` | `ejs.zip` |

不是“最新版本”承诺。基线用于回归和可审计资源选择，不永久禁止用户更新插件。

公开归档来源：

```text
https://codeload.github.com/N0VI028/JS-Slash-Runner/zip/8e0f4324e7d051025a333831411f03bd3145fac8
https://codeload.github.com/zonde306/ST-Prompt-Template/zip/d6f520d149aba146305b0b781ddd691d449c28d2
```

SHA-256：

```text
helper.zip  be7919088b9fdb0edf0544b683cdc23895823a463c7a8b36536ad517bdc5c07a
ejs.zip     1a866075e0bf7499f4fb0c39e5e763077aeddfee851624b4464289176943546b
```

## 资源路径

- 默认构建不含第三方插件；显式 `--plugins <bundle.json>` 构建到 `.build/assets-p3`。
- 使用上游已经编译的资源，不执行第三方 npm 生命周期或构建脚本，不修改插件源码/编译文件。
- 保留 `/scripts/extensions/third-party/JS-Slash-Runner/` 和
  `/scripts/extensions/third-party/ST-Prompt-Template/`，让原版发现和相对模块请求自然工作。
- discover 记录真实提交及 manifest 版本，不伪造 Git branch、远端状态或在线版本接口。
- 保留 runtime、LICENSE、说明以及原始 `__source.zip`。不将 map 文件作为单独运行资源，
  完整源归档仍保留原内容。
- SHA-256 在解析 ZIP 前检查。限制路径、大小、展开量和条目数，拒绝符号链接、
  目录穿越、Windows 保留名、大小写重名。构建时重新从归档导出文件清单并检查缓存字节，
  不信任可编辑的 bundle 文件清单。
- 所有插件资源、源码归档和 API 都先鉴权。没有扫描本地已安装插件、私有角色卡或聊天。
- 生成独立无自定义规则的 `css/user.css`，修复原 HTML 引用缺失产生的 MIME 报错。
  不读取开发者的私有 CSS；原版界面中的设置型自定义样式仍走原实现。

资源清单：Helper 12 个文件、EJS 110 个文件，包含各自完整归档。
P3 资源总计 742 文件、77,355,343 字节；默认包另行构建，两者不混用。
这些是本地资源清单，不是免费账户 CPU、首屏传输量或账单测量。

## 许可记录

本轮实读仓库文件：Helper 附带 AFPL v9，EJS 附带 AGPL-3.0。
保留原许可和完整源码只是资源处理措施，不是公开再分发或组合许可获准的结论。
当前仅在本地显式选择的独立包内验证，没有上传、发布、云端部署或运行第三方安装脚本。
AFPL 再分发及与 ST 发行项目的许可关系继续作为发布前待审查项。
这与 Workers 不提供原生 Git 文件目录是两个问题，不能混为“CF 禁止插件”。

## 已验证流程

`check-p3-local.mjs` 启动真实本地 Worker、隔离 D1/R2 和只返回固定文字的合成模型。
使用独立原版前端页面加载真实的上述两插件；没有模拟 TavernHelper 或 EjsTemplate 对象。

1. 未认证访问 manifest、编译入口、LICENSE 和完整源码归档均为 401；认证后原路径可读取。
2. Helper 五类变量：global/preset/character/chat/message 的实际 API 写入和读取，
   嵌套未知值包括 null、false、数组和对象。
3. EJS 直接求值读取 Helper 全局/聊天变量，保存 local 作用域变量到聊天元数据。
4. Helper 修改世界书、命名预设和全局正则；世界书/预设模板与正则结果进入实际模型请求，
   请求中不残留 EJS 标记和应被正则替换的合成文本。
5. 原版 UI 非流式生成，加上 Helper 非流式 generate/generateRaw，共捕获 3 个模型请求。
   两个脚本生成 API 返回模型正文，调用前后聊天条数相同。
6. Helper 修改消息并写入两个回复分支，点击原版左右按钮恢复对应消息变量。
   测试等待原版可切换状态和短暂 UI 稳定时间，不连续抢占动画。
7. 真实全局脚本 iframe 使用父窗口 API/EJS；启用、停用、再启用，
   mount=2、pagehide=1、事件命中=2，停用后发送事件不再触发旧监听。
8. Helper 创建 HTML 消息并由真实渲染 iframe 显示按钮；点击更新聊天变量且显示值变化。
9. 关闭桌面上下文，全新 390x844 手机会话恢复五类变量、脚本、消息按钮，
   世界书、预设编辑和正则。按钮继续从 1 增至 2，无页面横向溢出。

测试使用完整原版 Default 预设的 prompts 和 prompt_order，不能把启动 settings.json
仅含旧角色顺序的片段直接当作一个完整命名预设。

本轮本地 HTTP 失败 0、未处理页面异常 0、未预期控制台错误 0，后端 Token 请求 0。
原版预设切换可能在 openai.js 输出 `AbortReason`，
仅当对象类型、来源文件和原因为 `Chat Completion source changed` 都匹配时，
作为连接状态检查取消单独记录，不隐藏其他错误。

## 外部依赖

锁定的是插件归档，不是全部网络依赖。保持插件原编译文件意味着仍有其原始 CDN 请求：

- testingcf.jsdelivr.net 上的 Vue、Vue Router、Helper log.js。
- 消息 iframe 的 jQuery、jQuery UI、touch-punch 和 Font Awesome 样式。
- GitLab 的公开 Helper manifest 检查；不是本项目已经实现了插件在线更新。

回归只允许源码中实际使用的上述精确 URL，其他站外请求使测试失败；
Basic 凭据绑定本地 origin，不向这些域名附加本实例密码。
这是测试网络限制，不是生产插件安装白名单。
这些 URL 有浮动版本，本轮成功不保证未来内容或可用性不变；
没有改为本地桩资源，也不声称完全离线/全依赖可复现。
任意社区脚本的其他模块还需逐项测试。

iframe 插件脚本能访问父窗口数据，不是可信的隔离沙箱。
用户必须信任自己启用的脚本和它们加载的第三方代码；访问鉴权不能消除浏览器脚本风险。

## 独立原版生成专项

`check-p3-generation-local.mjs` 分别启动 Workers 与完整原版 ST，安装同一显式归档包。
原版来自锁定 Git 提交，关键源码逐字节检查，保持自己的 Node 后端、Tokenizer、认证和 CSRF。
两端分别初始化公开默认预设和完整合成卡，不共享已装配的提示词、变量或数据目录。

18 个状态/事件检查点和两端各 18 份实际模型请求通过：

1. Helper generate/generateRaw/custom_api 流式文字、中文跨字节分片、中间流事件与最终结果。
2. 延迟 429 的普通/自定义生成均拒绝，没有成功结束事件、聊天追加或自动重试。
3. 按 ID 停止、取消后复用 ID、模型未返回响应头时停止；上游连接实际关闭。
4. 已占用 ID 拒绝重复调用；原版停止按钮只停止绑定任务，静默任务继续；
   stopAllGeneration 停止两个静默任务，随后正常生成恢复。
5. 原版流式发送、重生成、新 swipe、左右分支切换；中断停顿流的重生成后再次成功生成。
6. EJS 预设/Raw 模板进入实际模型请求前求值，非幂等计数只增加一次；
   回复模板相对继承的消息变量只增加一次。手机新消息的计数 1 到 2 是继承后递增，不是两次执行。
7. 两边的全新 390x844 手机会话恢复消息、变量、分支和流式开关，再各自发送一条消息。

Helper 在流结束时本来就会再发最终 full/incremental 事件；最后一个 incremental 可以为空。
EJS 的 before_end 监听器包含异步等待，因此后注册观察者可能先收到 ended 再收到 beforeEnd。
测试保留实际顺序并逐项对照原版，不强行重排事件；started/beforeEnd/ended 各一次。
原生停止按钮的两个无 ID GENERATION_STOPPED 在本例与原版相同；
Helper 的对应 ID 停止事件各一次。后台显式 dryRun 试算单独记录。

发现并修复首包等待/完整事件间停顿时的流式取消延迟，处理方式及残余边界见 P2 契约。
普通快速错误保留 HTTP 状态，流头之后的延迟错误通过 SSE error 返回。
本轮故意注入两次延迟 429：原版有两条 429 响应及对应两条浏览器资源错误，按路径/阶段/内容精确记录；
Workers 两次都通过 SSE 拒绝。未预期 HTTP 错误、控制台错误及未处理页面异常均为 0。
Workers 后端 Token 请求为 0；原版有 57 次原生 Tokenizer 请求。

专项使用 8798/8799/8800 和 `.wrangler/p3-generation/<uuid>`，finally 关闭所有临时服务。
结果、完整原版参照信息和桌面/手机截图位于 `.build/p3-generation/<uuid>`，
`.build/p3-generation/latest.json` 指向最新一次；不把旧失败文件当作当前通过结果。

```powershell
node cloudflare/scripts/check-p3-generation-local.mjs <提供-playwright-的-package.json> <Chrome-可执行文件> <显式-bundle.json>
```

## 复现

在根目录执行，归档只取上文公开提交，分别命名 helper.zip/ejs.zip：

```powershell
node cloudflare/scripts/prepare-p3-plugins.mjs <归档目录>
node cloudflare/scripts/build-assets.mjs --plugins <输出的-bundle.json>
node cloudflare/scripts/check-p3-local.mjs <提供-playwright-的-package.json> <Chrome-可执行文件>
```

测试使用回环端口 8796/8797、独立 `.wrangler/p3-test/<uuid>`，
并在 finally 中停止浏览器、Worker 和合成模型。结果/截图位于 `.build/p3-browser/`。
目录中的旧 failure 文件可能保留诊断，以最新执行结果及 `results.json` 为准。

独立 P3 预览，在 cloudflare 目录执行：

```powershell
node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --persist-to .wrangler/p3-preview
node node_modules/wrangler/bin/wrangler.js dev --local --ip 127.0.0.1 --port 8795 --inspector-port 9245 --assets .build/assets-p3 --persist-to .wrangler/p3-preview
```

默认预览仍为 8788；独立存储验收实例仍为 8789。所有开发服务只监听回环地址。
P3 预览不复用合成模型测试数据，不写入原 ST 的用户目录。

## card2 源包与修订卡

用户补齐源包后的专项见 `P3-CARD2.md`，原卡及原始 ZIP 未修改。
另建 v1.1 卡与标准库构建入口，修订可扩展物品栏、完整备用初值、
错误的旧值保证、深色 jQuery 面板及缺失快照提示。
不执行原包引用的个人技能脚本，不把作者自模拟记录称为本轮真模型验证。

32 个双环境检查点、26 条作者操作、每边 22 份固定回复请求一致，
覆盖 EJS 三档、时序元数据、递归反向实验、重生成/分支/手机重载与发送。
原卡 15 个检查点基线再次通过，原有卡/runtime 问题保持作为对照。
CDN 使用前轮真实记录的哈希校验重放，不声称本轮网络可达或生产依赖完全离线。

sticky/cooldown/delay 按消息计数，不能直接按作者表中的“轮”断言。
MVU 默认在第 25 条消息时清理旧楼层变量；两端相同，面板不把缺失数据显示为真实的 0。
事件发出与监听器回调分别记录，已经列出的重生成/新分支没有重复助手更新；
不承诺所有社区监听器的回调相对次序相同。

## 尚未通过

- 灯塔 T/N 的真实模型自主填表、只读/范围遵循，其他社区卡及复杂状态栏。
  原卡问题及修订依据见 `P3-LIGHTHOUSE.md`、`P3-CARD2.md`，不把修订卡结果外推到原卡。
- 其他事件/监听器竞态、MVU 节流下的快速连续操作、历史变量清理后的手动/自动恢复。
- 其他 Helper API 和复杂事件顺序；非流式首包前取消、未完整 SSE 事件中途停顿的快速取消。
- 两插件联动的角色切换、导出再导入、长期 iframe/blob 资源回收。
- 其他 API、其他资源作用域及高级调用，真实模型提供商。
- P4 在线安装、版本查询、更新/回滚；对应后端接口仍明确 501。
- 公开再分发许可审查、真实免费 Workers 部署和性能。
- P1/P2 已记录的未完成项，不因开始 P3 而关闭。

## 用户测试卡

不要求 Workers 专用格式，也不要求提前删掉正常的浏览器功能。
首轮使用能在原版 ST 正常运行的单角色 PNG 或 JSON，内容只用非敏感测试副本。

- 带齐内嵌或外置的世界书、正则、预设、MVU 初始化/更新脚本与必需的快捷回复。
  已经内嵌的资源无需重复提供，但应说明哪些依赖需要另外启用。
- 记录原版 ST、酒馆助手、EJS、MVU 及其他必需扩展的版本/来源；外部模块 URL 也列出。
- 给出两三步可重复操作和预期结果，例如初始变量、回复后数值、重生成/左右分支应恢复的值。
  有状态栏/按钮时说明一次点击的预期变化，刷新后哪些状态应保留。
- HTML、图片、状态栏和按钮可以作为验收内容；语音、生图、服务端推理及本地服务依赖不纳入支持承诺。
- 不附 API 密钥、账号口令、私人聊天或唯一一份原始资料。

不需要第一张就做成巨型卡；先用完整的小流程验证 MVU，再扩大世界书、脚本和上下文规模。
