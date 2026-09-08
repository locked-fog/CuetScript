# CuetScript 技术设计

版本：Draft 0.1

日期：2026-09-08

状态：实现前设计；本文接口与命令均为拟定契约，尚未实现或完成真实模型验收。

本文件落实 [项目设计](CuetScript.md) 中的业务规则。项目设计定义故事语义，本文件定义技术边界、数据契约、部署依赖与验收方式；发生冲突时先更新两份文档，不让实现自行选择相反规则。

## 1. 已确定的首期范围

| 项目 | 决策 |
| --- | --- |
| 运行环境 | 使用当前机器 Node.js 26；实测 v26.8.1，不安装或切换 Node 24 |
| 语言 | TypeScript、ESM、strict，编译输出 JavaScript；类型检查独立执行 |
| 产品入口 | `cuet` CLI，核心模块不依赖 CLI；UI 后置 |
| 模型适配 | DeepSeek 官方 API 必须可用，支持三个角色槽位独立配置 |
| Lorebook RAG | 首期部署必须包含真实 Embedding → 向量召回 → Reranker → 版本化引用 |
| RAG 模型 | SiliconFlow 的 Qwen/Qwen3-Embedding-8B 与 Qwen/Qwen3-Reranker-8B |
| Gemini Antigravity | 参考 dsh-agy，按第 6 节进行兼容验证；通过后作为独立 Provider 启用 |
| 故事版本 | 系统 Git，文件作为 Canon，分支作为故事路线 |
| 执行与缓存 | 本地 SQLite；不可丢弃的运行库和可重建索引库分离 |
| 并发 | 同一分支单写入者；首期 Actor 串行 |

RAG 必需不等于需要部署独立向量服务器。首期采用本地向量存储与精确召回，完整调用外部 Embedding 和 Reranker。专用向量服务、大规模 ANN、Actor 并行和复杂模型路由可以后置。

## 2. 工具链与依赖选择

- npm 与 package-lock.json：实现阶段固定直接依赖版本，使用 `npm ci` 复现；本次文档提交不创建空 package.json 或安装依赖。
- TypeScript：开启 strict、noUncheckedIndexedAccess，使用与 Node 26 对应的类型声明。
- Node HTTP 能力：DeepSeek / SiliconFlow 先使用 fetch 和 AbortSignal，SSE 解析封装为独立模块。传输层可替换，业务代码不依赖 SDK 消息类型。
- `yaml`：读取 YAML 1.2 文档并检查 AST，拒绝 anchors、aliases、tags、复杂键、重复键及非 JSON 数值。不能仅凭解析成功接受 Status。[解析库文档](https://eemeli.org/yaml/)
- JSON Schema + Ajv：校验工具参数、配置、Status Envelope 与 Transaction，禁止隐式类型转换。开放 status 节点只限制 JSON 兼容性，不强加统一角色 Schema。[Ajv 文档](https://ajv.js.org/)
- RFC 6901 / 6902：使用标准 Pointer / Patch，选择通过标准用例的实现库；库版本在首次实现时锁定，不自行发明近似语法。
- SQLite：优先评估 Node 26 的 `node:sqlite`，数据库调用封装在 Repository 层；同步操作保持短事务，耗时索引工作放 Worker，不在网络调用期间持有写事务。[Node SQLite 文档](https://nodejs.org/docs/latest-v26.x/api/sqlite.html)
- Commander：薄 CLI 参数层。Vitest：单元、集成和故障注入；真实模型验证单独运行。[Commander](https://github.com/tj/commander.js)、[Vitest](https://vitest.dev/guide/)
- Git：通过进程参数数组调用系统 git，检查退出码；不将模型生成文本插入 shell 命令，不允许任意 Git 命令绕过发布边界。

本机已完成 `node:sqlite` 的内存数据库创建与版本查询，返回 SQLite 3.53.4；这只验证内置模块可用，不代表项目持久化与恢复已通过。Node 版本基线来自本机实测，并非依照 LTS 默认选择。升级运行时和依赖必须重新执行 Provider 与恢复验收。

## 3. 模块划分

以下是规划结构，不表示已创建代码：

```text
src/
  core/          # Turn、Session、Scene Draft、上下文及状态转换
  runtime/       # Agent Loop、工具注册、预算、取消、重试与恢复
  providers/     # deepseek、antigravity、统一传输事件
  status/        # YAML、Pointer、Patch、变更依据和事务验证
  lore/          # 条目管理、分块、Embedding、向量召回与 Reranker
  storage/       # 文件、运行 SQLite、派生 SQLite、Git 发布
  cli/           # 命令与终端呈现
```

Core 依赖接口，不直接访问环境变量、进程或 Provider SDK。CLI 只负责输入输出；Provider 不操作 Canon；Gateway 只读取授予任务的材料，不能自行查询完整 Lorebook。

不引入新的审核 Agent，不将全部 Runtime 委托给通用 Agent 框架。模型负责语义判断，普通程序负责状态迁移、范围限制和持久化。

## 4. 数据与协议契约

所有业务记录携带 schema_version。内部 ID 是稳定标识，模型展示名不作为关联主键。

| 记录 | 必要内容 |
| --- | --- |
| Turn | turn_id、分支、Input Commit、用户输入类型、控制权、预算、执行状态 |
| Invocation | invocation_id、turn_id、Agent 槽位、结束结果、重试次数 |
| Scene Draft | draft_id、revision、base_commit、完整候选正文、表演点与临时进展 |
| ActingTask | invocation_id、角色 ID、草稿修订、授权上下文引用、当前刺激与建议 |
| ActingResult | 自然语言表演、来源调用、依赖修订、是否已采纳 |
| ContextReference | 源 Commit / 内容哈希、文件或条目 ID、Pointer / 段落、知情范围 |
| Status Transaction | transaction_id、基础版本、各文档 Patch、正文依据及草稿哈希 |
| Acceptance | acceptance_id、turn_id、预期 HEAD、候选树、已发布 Commit 的外部映射 |

ActingResult 正文保持自然语言；结构化元数据由 Runtime 附加，不要求 Actor 输出人物数值。Scene Draft 的基础事实与临时进展分别标识；变更前文使依赖结果失效，修订后的 Transaction 重新验证。

统一 Provider 请求包含 model、messages、tools、generation options、deadline / abort signal。messages 支持文本、工具调用、工具结果及不透明 provider_data。流式事件至少包括 text_delta、tool_call_delta、usage、finish、error；仅在工具参数完整解析并通过 Schema 后执行工具。

Provider 能力表分别描述 tools、streaming、thinking、sampling、schema subset、replay requirements 和 usage availability。不支持的关键能力返回明确错误，不能默默忽略。模型目录缓存带获取时间，显式配置的模型在 preflight 中验证。

工具调用 ID 与 provider_data 关联到 Provider、模型、Session 和具体消息。Provider 切换时从 Canon 与写作约束重建上下文，不把另一家的推理回放数据强行转换后重放。

## 5. DeepSeek 官方 API：首期必需

首期使用官方 `https://api.deepseek.com/chat/completions`，密钥引用 `DEEPSEEK_API_KEY`。官方当前列出 deepseek-v4-flash 和 deepseek-v4-pro；模型 ID 作为配置，不在 Runtime 中硬编码旧别名映射。可用性需要部署时请求验证。[官方入门](https://api-docs.deepseek.com/)

适配要求：

1. 支持普通文本、流式文本、工具参数累积、多个工具调用与 tool_call_id 对应的工具结果。
2. 独立配置 thinking 与采样参数。当前官方说明 thinking 模式下 temperature / top_p 等不生效；适配器应明确提示配置冲突，而不是让用户误以为参数有效。
3. 完整保存 `reasoning_content`。当前带 tools 的请求要求回传相关历史 reasoning_content，不能只保存正文和工具参数。无工具请求遵守对应模式规则。[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
4. 工具 Schema 在本地严格验证。Provider 的 strict 模式属于可选能力，不作为 MVP 正确性的唯一保证。[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)
5. 分别记录 Provider 请求 ID、模型、Token、延迟、finish reason 与重试；正文截断不能被当作完整工具提交。
6. 对 429、超时和可恢复服务错误采用预算内退避。认证、非法参数与无效历史不盲目重试。网络重试与业务幂等分别处理，不承诺外部生成调用 exactly-once。

验收必须在 DeepSeek 官方端点执行：Actor 单次表演、Writer runActor → submit、Orchestrator runWriter → Turn Result，以及工具调用后重启恢复。至少验证 thinking 开启的工具链，记录真实请求与结果；密钥和授权头不进入记录。

## 6. Gemini Antigravity 与 dsh-agy 可行性

### 6.1 核查依据

2026-09-08 阅读上游源码，固定参考 Commit：

`e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33`，该 Commit 的 package.json 版本为 `0.2.6`。这是源码审阅基线，不代表已安装 npm 包或完成模型验证。

- [package.json](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/package.json)：公开 exports 为插件入口、web、client 和 package.json；未提供独立 AgyAdapter 子路径。
- [src/index.ts](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/src/index.ts)：入口向 Cordis / DSH 的 llm 服务注册适配器。
- [adapter.ts](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/src/adapter/adapter.ts)：依赖 dsh-llm 的适配协议；[translate.ts](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/src/adapter/translate.ts) 与 [parse.ts](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/src/adapter/parse.ts) 分别承担请求转换和 SSE 解析。
- [signature-cache.ts](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/src/runtime/signature-cache.ts)：签名当前保存在带 TTL 的进程内 Map，缺失时使用 sentinel。
- [cordis.patch.yml](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/cordis.patch.yml)：默认同时包含 Provider 与 Web 插件，Web 依赖 webServer。
- [LICENSE](https://github.com/chaos-03x/dsh-agy/blob/e0de9aaf8dcbfd84d8ca328bb9ad9785d5d5be33/LICENSE)：MIT；若引入或修改其代码，必须随复制部分保留版权和许可声明，并记录来源 Commit。

### 6.2 接入决策

源码提供可行参考，但不能把 `import { AgyAdapter } from 'dsh-agy'` 当作现有公共 API。CuetScript 优先采用独立 AntigravityAdapter，参考并在需要时按 MIT 许可移植最小认证、请求转换和流解析模块；将 DSH 消息类型替换为本项目契约。若上游后续提供独立核心入口，再评估直接依赖。

DSH Provider-only 桥接可以作为兼容验证备选，但不得启动另一个 DSH Agent Loop 代替 CuetScript 的 Orchestrator / Writer，也不把 Web 管理插件作为无界面运行的必需项。桥接所需 DSH 与 agy 版本必须单独验证并锁定，不能从其他项目的旧组合推断本项目兼容。

首期接入范围限 Gemini、单个明确授权账号、登录/刷新、模型发现、生成、工具往返与恢复。账号池调度和管理界面不是接入先决条件。该路径与 Gemini 官方 API Key 接口分开命名与配置，不混称官方 Gemini API 适配。

### 6.3 必须调整及验收的边界

- OAuth 状态、刷新令牌和账号存储放 CuetScript 独立私有目录，不读取或改写其他项目的 DSH_HOME；不把授权信息写入 Story Git。
- 将收到的真实 thoughtSignature 与对应消息、工具调用、模型及账号范围持久化为 provider_data，进程重启后恢复。不能依赖上游进程缓存或假定 sentinel 永远可接受。
- Schema 转换不允许静默删掉影响语义的约束；不可表达的工具在本地拆分或明确拒绝。保留工具名称双向映射，保证返回调用可准确路由。
- 账号变化、模型变化或签名失效时执行受控上下文重建，保留已执行工具结果；不能为恢复签名重复执行有副作用工具。
- 通过真实 OAuth、模型发现、单次文本、至少两轮工具往返、工具返回后进程重启、取消和失败恢复，才能标记 Provider 可用。仅 CLI 登录成功或上游测试通过不足以验收。

若该路径因上游协议变化无法通过，明确记录阻塞及证据，保留可工作的 DeepSeek + RAG 主路径；不得将 Antigravity 标为已支持。本轮只做技术设计和源码核查，没有执行 OAuth 或模型请求。

## 7. Lorebook RAG：首期部署完整链路

### 7.1 Provider 和索引

部署默认 SiliconFlow 国内端点 `https://api.siliconflow.cn/v1`，密钥引用 `SILICONFLOW_API_KEY`；区域端点可配置，但不自动跨区域切换。

- `/embeddings` 使用 `Qwen/Qwen3-Embedding-8B`，发送条目的 title + content，批量输入按响应 index 对应回源；检查向量维度与有限数值。[Embedding API](https://api-docs.siliconflow.cn/docs/api/embeddings-post)
- `/rerank` 使用 `Qwen/Qwen3-Reranker-8B`，发送 query 和候选文本列表，通过返回 index 映射源片段。[Rerank API](https://api-docs.siliconflow.cn/docs/api/rerank-post)

短条目整体索引。长条目按标题与段落分块，超长段落进一步切分，保留 entry_id、chunk_id、字符偏移和源哈希；不静默截断。分块策略版本、向量维度、模型和区域端点均进入索引配置指纹。具体输入上限按部署时 API 能力确认，超限时拆分而非丢弃尾部。

SQLite 存向量 BLOB 与元数据；进程内做精确余弦召回，数据量增长后再换专用索引。查询向量与语料向量必须来自一致的模型和维度配置。首期不需要向量服务器，但必须有真实向量检索。

### 7.2 查询契约

```text
Orchestrator 生成 Query
→ 确认当前 Commit 的 Lore 索引清单
→ Query Embedding
→ Vector Top-K（默认 20，可配置）
→ Rerank（默认返回 5 个片段，可配置）
→ 去重并返回条目、片段、分数、源 Commit / 哈希
→ Orchestrator 选择和分配知情范围
→ 注入 Writer / Actor
```

search 接口除了 query，必须携带 source revision 和 limit。召回数量不足时使用实际数量；空 Lore 返回带原因的空结果，不向 Reranker 发送空数组。分数不作为世界事实的置信度。

条目更新、删除与分支切换产生新的索引清单。构建在独立 generation 中完成后整体切换；查询不能混用新旧条目。正文提交但 Lore 未改变时，可按内容指纹复用索引，不要求每轮重新嵌入。

必要 RAG 不可用时返回 `rag_unavailable` 或 `index_not_ready`，保留 Turn 可恢复状态。不得默默改用关键词搜索并声称 RAG 已完成。人工读取原文仅作为明确标注的恢复手段，不替代首期 RAG 验收。

### 7.3 RAG 验收

准备有明确预期条目的真实 Lore 集，包含近义表达、同名异义、长条目、无相关结果、更新和删除。记录召回与重排前后排名、原文引用、调用耗时和 Token；使用至少一轮必须依赖 Lore 的真实故事生成检查最终上下文确实采用正确片段。

重启、切分支、改模型维度及删除条目后再查，不能返回旧来源。安装成功、SQLite 存在或 HTTP 200 均不构成端到端验收。

## 8. 持久化和结果发布

规范数据保留 Markdown / YAML / JSON，Git 作为唯一故事版本权威。运行状态数据库与派生索引数据库分开：

```text
story/
  status/ lore/ prose/ user-input/ prompts/ config/
  notebook.md
  metadata/              # Turn 记录、范围元数据、接受标识
  sessions/              # 已接受结果对应的有效恢复记录
  runtime/execution.db   # 不可丢弃：调用、草稿、provider_data、恢复操作
  cache/lore.db          # 可重建：向量、片段、索引 generation
```

runtime 与 cache 排除在 Story Git 之外，完整备份仍必须包含 runtime。密钥放故事目录之外，配置只引用凭据名称。运行库事务仅包围本地记录更新，不跨网络或 Git 命令持锁。

发布顺序：

1. 持久化 input，创建 Input Commit；记录该输入尚未消费。
2. 在执行库持久化 Invocation、工具调用、Tool Result 和草稿修订。
3. 冻结候选正文，生成带正文依据的 Transaction；在隔离候选树应用并验证完整 Turn Result。
4. 建立包含 acceptance_id、turn_id 和基础 Commit 的 Result Commit。
5. 在分支锁下检查预期 HEAD，以引用比较更新发布；失败返回 version_conflict。
6. 更新执行库的发布映射，返回用户；派生索引按需构建。

Git 与 SQLite 不存在共同事务。若步骤 5 成功而步骤 6 失败，恢复器从 Git 中的 acceptance_id 确认发布事实，再修复数据库。未发布的候选 Commit 不算已接受。Result Commit 内不写自己的哈希，避免自引用。

读取采用已发布 Commit 的一致文件树。工作区同步必须受控，存在用户未提交修改时不覆盖；保留候选输出并提示处理冲突。每个副作用工具以调用 ID 去重；未知网络结果允许重复生成请求，但不允许重复接受结果。

## 9. 上下文、状态和预算

Context Assembly 从指定基础 Commit 读取数据，以授权引用筛选 Actor 材料；Writer 不收到全部 Notebook，Actor 不收到完整 Draft。认知元数据不能推导任意正文语义，关键缺失由 abort 请求补充。

Status Patch 在文档副本上验证，再进入完整候选树；固定 Envelope 标识不可改写。世界事实和角色信念分别记录，角色台词不自动升级为 Canon。每个关键变化引用冻结正文。

Runtime 统一限制模型调用数、重试、Writer 修订、补充信息往返、耗时与费用。RAG 请求同样计入预算。费用缺失标记 unknown，不能写成 0。取消传播到网络调用，已持久化工具结果与已发布 Turn 不撤销。

Session 完整执行日志与下一次有效上下文分离。重建保留文风、Canon 和未完成目标，丢弃不再有效的候选内容；Provider 原始回放片段按协议保留或受控重建，不能在工具调用中间随意压缩消息链。

## 10. CLI 与部署契约

拟定命令族，最终参数在实现时冻结：

```text
cuet doctor                  # Node / Git / 配置 / 凭据引用 / 数据版本
cuet provider check <name>   # 显式执行对应 Provider 的真实连通与能力验证
cuet lore index              # 建立当前 Story 的完整向量索引
cuet lore search <query>     # 返回来源与重排结果
cuet run                    # 接收分类输入，执行 Turn
cuet resume <turn-id>        # 按记录恢复，已发布则展示结果
```

普通 doctor 不自动启动付费模型请求；部署验收显式运行 Provider 和 RAG 检查。首期可运行交付必须包含 Node 26 工具链、系统 Git、DeepSeek 配置、SiliconFlow 配置和已验证 RAG。Antigravity 未通过时状态明确显示 unavailable，而不是假装兼容。

配置文件只保存 endpoint、model、thinking、预算、检索参数与 credential reference。日志排除 Authorization、OAuth token、账号导出文件和密钥；真实故事与执行记录默认保留在本地，不随源码仓库上传。

## 11. 实施顺序与验收门槛

阶段是实现顺序，不用于将 RAG 排除出首期交付。

| 阶段 | 产物 | 通过条件 |
| --- | --- | --- |
| A：协议与存储 | 类型、Schema、调用日志、Git 候选发布 | 真实临时仓库故障注入，无部分 Canon、无重复接受 |
| B：必需 Provider 与 RAG | DeepSeek Adapter、SiliconFlow Embedding / Rerank、本地索引 | 官方端点真实工具链；真实 Lore 完整检索和版本切换 |
| C：叙事闭环 | Orchestrator、Writer、串行 Actor、Scene Draft | 真实多轮场景、用户决策点、状态依据与知情隔离 |
| D：Antigravity 可行接入 | 固定来源的独立适配或 Provider-only 桥接 | Gemini OAuth、工具往返、签名重启恢复；失败保留证据 |
| E：分支和文学对照 | Regenerate / Retcon 恢复、Writer/Actor 对照记录 | 无未来 Session 或旧索引污染，报告质量/成本/延迟 |

首期完成至少要求 A、B、C 和必要的分支恢复验证；D 只有通过才列入支持矩阵。项目设计第 49 节的故障与叙事场景仍为验收依据。公开仓库当前仅有设计资料，不能据此宣称实现已完成。
