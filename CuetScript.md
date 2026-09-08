# CuetScript 技术设计文档

版本：Draft 0.3

本版补充场景草稿、角色知情范围、Session 上下文重建和整轮提交规则，并修订 Writer 结束协议。技术栈尚未定型。

## 1. 项目定义

**CuetScript** 是面向长期、开放式 Roleplaying 场景的多模型叙事系统。

项目名称中的 `Cue` 指表演过程中的提示与出场信号，`Cuet` 同时保留接近 `Cute` 的读音。命令行工具名称统一为：

```text
cuet
```

传统 RP 系统通常采用单模型续写流程：

```text
用户输入
→ 拼接角色卡、历史记录、Lorebook 和附加提示词
→ 单模型生成回复
→ 将回复追加至历史
```

该结构要求单个模型同时处理角色扮演、长文本写作、剧情推进、角色一致性、世界状态、上下文管理和长期记忆。

CuetScript 将这些职责拆分到多个模型和本地组件中。系统主要包含：

- `Orchestrator`
- `Writer`
- `Actor`
- `Status System`
- `Lorebook RAG`
- `Notebook`
- `History / Memory`
- `Git`
- `Provider Adapter`

---

# 2. 设计目标

CuetScript 主要处理以下问题。

## 2.1 长文本生成

传统 RP 模型通常将一次用户输入解释为一次聊天回复，因此倾向于生成较短内容。单纯设置最低字数不能稳定解决该问题。

CuetScript 将角色扮演和长文本写作分离：

```text
Actor
→ 负责单个角色的 RP 表演

Writer
→ 负责完整场景和长文本写作
```

Writer 可由 Orchestrator 多次调用，以完成一个较长场景。

---

## 2.2 场景与角色状态一致性

长期 RP 中需要持续维护人物、身体、服装、物体、地点和关系状态。

CuetScript 使用 `Status` 维护当前事实，不要求模型依赖历史正文自行恢复所有状态。

---

## 2.3 上下文规模与成本

不同模型只接收完成当前任务所需的信息。

完整故事历史不作为所有模型的统一 Prompt。

Orchestrator 根据模型职责选择：

- Current Status；
- 相关 History；
- Memory；
- Lore；
- Notebook 信息；
- 用户输入；
- 当前正文。

不同 Provider 可以使用不同的缓存和上下文布局。

---

## 2.4 信息偏移

摘要、Memory 和检索结果均可能产生信息损失或偏移。

CuetScript 将原始数据保存在本地，并将压缩信息视为派生数据。需要时可重新读取 History、Status 或 Lore 生成派生信息。

---

## 2.5 角色长期变化

角色的性格、外观、关系、身体、身份和性别均可能随故事变化。

因此，角色卡不作为永久不变的 Prompt。角色初始设定表示为 `Initial Status`，故事中的变化写入 Current Status。

---

# 3. 基本原则

## 3.1 自然语言优先

以下内容主要使用自然语言：

- 角色表演；
- 人物性格；
- 心理状态；
- 剧情规划；
- Writer 写作要求；
- Orchestrator 审核意见；
- Notebook。

不要求将文学判断转换为固定数值。

例如：

```text
当前仍有明显不满，但主要表现为回避和轻微讽刺，没有主动升级冲突的意图。
```

优先于：

```text
anger = 0.72
avoidance = 0.83
```

结构化格式主要用于：

- Tool Call；
- Status Patch；
- Status Transaction；
- RAG 接口；
- Git 操作；
- Runtime 协议。

---

## 3.2 当前事实优先

当 Initial Status 与故事中已经发生的变化冲突时：

```text
Current Status > Initial Status
```

初始角色设定不得覆盖已经发生的人物变化。

---

## 3.3 Canon 与计划分离

已经发生的剧情和当前状态属于 Canon。

未来剧情计划、候选暗线解释和待回收伏笔的规划属于 Notebook。已经成立但尚未公开的幕后事实属于隐藏的 Canon，见第 17.3 节。

因此：

```text
Committed History / Current Status > Notebook
```

Notebook 中的计划不得直接视为已经发生的事件。

---

## 3.4 缓存不参与正确性定义

Prompt Cache 只用于性能和成本优化。

模型在 Cache Miss 时仍须正常工作。

Actor 不建立长期 Session，也不因缓存策略与角色绑定。

---

## 3.5 原始数据持久化

以下数据应保留原始版本：

- 用户输入；
- 最终正文；
- Initial Status；
- Current Status；
- Lore；
- Notebook；
- Agent Session；
- Git 历史。

Memory 和摘要可重新生成。

---

# 4. 总体架构

```text
                         User
                          │
                          ▼
                    Orchestrator
                   Persistent Agent
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
       Status         Lorebook RAG      Notebook
          │               │                │
          └───────────────┼────────────────┘
                          │
                     runWriter(...)
                          │
                          ▼
                       Writer
                   Persistent Agent
                          │
                     runActor(...)
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
           Actor A     Actor B     Actor C
           Ephemeral   Ephemeral   Ephemeral
              │           │           │
              └───────────┼───────────┘
                          │
                          ▼
                       Writer
                          │
                    submit / abort
                          │
                          ▼
                    Orchestrator
                          │
                Prepare Turn Result
                          │
                          ▼
                         Git
```

---

# 5. Agent 生命周期

## 5.1 Orchestrator

Orchestrator 是持续、单线的 Agent。

在未发生 Story Fork 的情况下：

```text
O1 → O2 → O3 → O4 → ...
```

Orchestrator 保持逻辑 Session，主要负责：

- 解析用户输入；
- 区分 RP、Direction、Author Note 和 OOC；
- 查询 Status；
- 查询 Lorebook；
- 查阅和编辑 Notebook；
- 读取 History 和 Memory；
- 编排 Writer 上下文；
- 调用 `runWriter(...)`；
- 审核 Writer 提交的正文；
- 生成 Status Transaction；
- 调用本地工具；
- 管理 Git；
- 处理 Regenerate、Retcon 和 Story Branch。

Orchestrator 不负责主要正文写作。

---

## 5.2 Writer

Writer 是持续、单线的 Agent。

```text
W1 → W2 → W3 → W4 → ...
```

Writer Session 在同一 Story Branch 上保持。

Writer 负责：

- 撰写最终正文；
- 组织多角色表演；
- 组织环境、动作、对话和过渡；
- 保持指定文风；
- 控制场景密度；
- 控制具体文本节奏；
- 处理语言模式重复；
- 在需要角色表演时调用 `runActor(...)`；
- 在信息不足时调用 `abort(...)`；
- 在完成当前写作任务后调用 `submit(...)`。

Writer 不直接修改 Canonical Status、Lorebook 或 Notebook。

---

## 5.3 Actor

Actor 是非持续、可多线并行的临时模型请求。

每次调用执行：

```text
ActingTask
→ 单次 Chat Request
→ ActingResult
→ 结束
```

同一角色的下一次 ActingTask 重新构造 Prompt。

Actor 不维护长期 Session。

角色连续性由以下信息提供：

```text
角色 Prompt
+ Current Status
+ 相关 History
+ 当前 Scene
+ 动态上下文
```

Actor 不绑定固定模型。相同角色可以在不同 ActingTask 中使用不同模型。

---

# 6. Orchestrator 与 Writer 的调用关系

Orchestrator 通过：

```text
runWriter(...)
```

委派写作任务。

`runWriter()` 在业务语义上是同步调用。

Orchestrator 发起 Tool Call 后暂停当前模型执行。Runtime 执行 Writer Agent Loop，直至 Writer 提交正文或请求更多信息。

`runWriter()` 有两种正常业务返回。

### 6.1 `submitted`

```json
{
  "status": "submitted",
  "content": "..."
}
```

表示 Writer 已提交候选正文。

### 6.2 `need_more_info`

```json
{
  "status": "need_more_info",
  "request": "需要确认喵子此前是否见过当前出现的角色。"
}
```

表示 Writer 缺少继续写作所需的信息。

Orchestrator 获取信息后，可以再次调用同一 Writer Session。

---

# 7. Writer 工具

Writer 默认提供三个业务工具：

```text
runActor(...)
submit(...)
abort(...)
```

其中 `runActor()` 是普通工具，`submit()` 和 `abort()` 用于结束当前 Writer Invocation 的业务工作。

---

# 8. `runActor(...)`

Writer 在需要角色实际表演时调用 `runActor(...)`。

例如：

```text
runActor(
    character = "喵子",
    scene = "...",
    suggestion = "对主人刚才的行为作出反应。整体保持轻松，不升级为争吵。"
)
```

返回值直接使用 Actor 的自然语言输出。

例如：

```text
喵子眯起眼睛看了他一会儿，随后又往他身边挤了挤。

「……主人今天是不是有点太关注别人了？」
```

Actor 输出不转换为情绪数值、行为枚举或其他固定结构。

---

# 9. Actor 上下文构造

Writer 决定何时需要 Actor，但不直接负责构造完整 Acting Prompt。

职责划分如下：

```text
Writer
= 决定何时需要角色表演

Actor Gateway
= 构造 ActingTask

Actor
= 执行角色表演
```

Actor Gateway 是普通程序组件，不重新调用 Orchestrator 模型。

一次 ActingTask 可以包含：

- 角色 RP Prompt；
- 当前角色 Status；
- 相关 History；
- 角色可知信息；
- 当前 Scene Status；
- 必要 Lore；
- 从当前 Scene Draft 中选取的角色可观察片段与场景进展；
- Suggested Action；
- 输出要求。

Writer 无需直接访问完整角色数据库。

Gateway 只从 Orchestrator 授予当前任务的上下文范围内读取信息。Orchestrator 提供带实体引用和知情范围的上下文材料，Writer 提供角色视角下的当前刺激与草稿进展。Gateway 负责引用解析、范围检查和 Prompt 组装，不承担对任意正文进行可靠语义脱密的责任。

完整 Draft 不默认传给 Actor。全知旁白、其他角色未表达的心理以及未授权的幕后事实不得直接注入。关键知情情况缺失时，Writer 使用 `abort()` 请求补充；没有记录不等于角色确定不知道。

---

## 9.1 Scene Draft

Scene Draft 表示本轮尚未提交的候选场景。它关联明确的 `turn_id`、基础 Commit、草稿修订号与当前表演点，包含候选正文和由其支持的自然语言场景进展。

```text
基础 Current Status
+ 当前草稿中已采纳的事件
= 当前表演点的临时场景依据
```

例如，草稿已经写出喵子脱下外套并放到沙发上，后续 Actor 必须以该临时变化为起点；基础 Current Status 暂不修改。整轮被否决时，这些变化不进入 Canon。

Writer 在 `runActor(...)` 中提供当前表演点之前的角色可观察进展及草稿引用。Runtime 持久化该修订，Gateway 将它与授权范围内的基础状态共同组装，并明确区分基础事实与草稿变化。Writer 不必每段生成 JSON Patch。

临时场景依据不是任意覆盖事实的权限：Writer 必须写出状态变化的过程。最终接受前，Orchestrator 检查其与基础状态的因果连续性。自然语言进展仍可能遗漏变化，因此保留对应正文依据，不能把临时摘要视为自动验证过的事实。

Actor 输出只有经 Writer 采纳并写入草稿后，才成为后续表演的临时依据。Runtime 记录每次表演依赖的草稿修订与表演点；修改前文时，默认使依赖受影响前文的结果失效。Writer 可在明确确认仍然适用后重新采纳，并记录依据，否则重新表演。

同一 Turn 内多次 `runWriter()` 操作同一 Scene Draft。调用必须区分继续、修订与补充信息；`submit(content)` 提交当前完整候选正文，Runtime 不将每次提交盲目追加。进入结果准备阶段后冻结修订；继续改写会使已有审核和 Transaction 失效。

## 9.2 Actor 调用依赖

默认按因果顺序串行表演。独立角色对同一刺激的第一反应可以并行；回应另一个角色的具体台词或动作必须依赖前一个结果。

并行结果仍由 Writer 选择和整合，检查争用同一物体、相互冲突的行动顺序等问题。MVP 先支持串行，不把并行作为叙事正确性的前提。

---

# 10. Acting Prompt

Actor 使用传统 RP Prompt。

基本结构：

```text
你是……

角色设定：
……

当前状态：
……

相关经历：
……

当前场景：
……

刚刚发生：
……

建议的行动：
……

输出要求：
直接以角色身份进行 Roleplaying。
输出角色的台词、动作和自然反应。
不要分析角色，不要解释创作过程。
```

Actor 每次调用只接收当前表演所需的信息。

Acting Prompt 不要求维护长期 Session，也不以缓存命中为设计前提。

---

# 11. Suggested Action

Suggested Action 用于控制角色表演方向，但不固定具体台词和动作。

例如：

```text
喵子对此有轻微的吃醋反应，但当前不形成正式冲突。
反应可以偏向撒娇、试探或主动寻求关注。
具体台词和动作由角色自行决定。
```

Suggested Action 使用自然语言，优先描述当前刺激、角色倾向与场景边界，不预先规定角色必须作出的答案。用户明确指定的剧情结果应标记为作者方向。

Writer 对最终正文负责，可以删减重复、调整衔接及在保持含义的前提下修改措辞。改变角色意图、关键选择或认知范围不属于普通润色：应重新请求 Actor 表演；涉及作者方向与人物一致性的冲突时，通过 `abort()` 交回 Orchestrator 裁决。

---

# 12. Actor 重试

Actor 输出是候选结果，不自动成为 Canon。

## 12.1 Resample

使用相同或重新编排后的 ActingTask 再次请求 Actor。

未提供旧输出时，不得在 Prompt 中引用：

```text
上一版
此前的表演
刚才生成的内容
```

## 12.2 Revision

需要针对既有输出进行修改时，必须显式提供旧结果：

```text
Previous Performance:
……

Revision Request:
降低直接对抗感，保留原有吃醋反应。
```

多个 Actor 请求之间不存在会话关系。

---

# 13. `submit(...)` 与 `abort(...)`

`submit()` 和 `abort()` 是业务层结束信号。Runtime 必须持久化对应的 Tool Call、业务结果与 Tool Result；缺少工具结果的历史不得作为完整会话直接重放。

业务完成与 Provider 消息链整理分别处理。Closing Model Call 是否需要执行，由 Provider Adapter 根据已验证的协议要求决定，不作为所有 Provider 的统一业务完成条件。

## 13.1 `submit(...)`

Writer 完成正文后调用：

```text
submit(content = "...")
```

Runtime：

1. 校验并持久化候选正文、Invocation 标识及对应草稿修订；
2. 将 Invocation 标记为 `SUBMITTED`，保存对应 Tool Result；
3. 如 Provider 需要，执行不提供 Writer Tools 的 Closing Model Call；
4. 将已经持久化的 `submitted` 结果返回 Orchestrator。

最终候选正文以 `submit()` 参数为准。额外 Assistant Message 不承担正文语义。`SUBMITTED` 只表示候选稿已提交，不表示 Turn Result 已被接受或成为 Canon。

Closing Model Call 失败时，保留成功提交的业务结果，记录会话尾部整理待恢复状态；不得重新生成正文或重复执行业务提交。下一次重放前由 Adapter 完成恢复，或从完整逻辑记录重建合法请求。

## 13.2 `abort(...)`

Writer 缺少必要信息时调用：

```text
abort(request = "需要确认喵子此前是否见过当前出现的角色。")
```

Runtime 保存请求与 Tool Result，将 Invocation 标记为 `NEED_MORE_INFO`，按 Adapter 要求整理消息链，再将已保存的信息请求返回 Orchestrator。会话尾部整理失败采用与 `submit()` 相同的恢复规则。

Writer Session 和当前 Scene Draft 保持。Orchestrator 补充信息后继续同一逻辑 Session。`abort()` 不删除草稿，也不将草稿写入 Canon。

同一 Invocation 只允许一次业务结束。重复请求必须返回已保存结果；单个模型响应同时提出多个结束信号，或混合结束工具与其他工具时，Runtime 拒绝该批调用并进行有界协议纠正，不部分执行其中的副作用。

---

# 14. Writer 非法结束

Writer 在未调用 `submit()` 或 `abort()` 的情况下正常结束时，当前 Invocation 不视为完成。

Runtime 应在同一 Writer Session 中追加协议提示：

```text
当前 Writer Invocation 尚未完成。

必须调用以下工具之一：
- submit：提交完整正文；
- abort：请求 Orchestrator 提供更多信息。

不得直接结束当前 Invocation。
```

随后重新调用 Writer。

协议纠正次数应设置上限。超过上限后返回 Agent Protocol Failure，避免无限循环。

---

# 15. Writer Session 术语

统一使用以下术语。

### Writer Session

Writer 在一条 Story Branch 上的持续逻辑会话。

### Writer Invocation

一次 `runWriter()` 调用期间的业务过程。

### Model Call

一次实际的模型 API 请求。

### Tool Roundtrip

一次：

```text
assistant.tool_call
→ tool_result
→ 模型继续执行
```

例如：

```text
Writer Session
│
├── Invocation 1
│   ├── Model Call
│   ├── runActor
│   ├── Model Call
│   ├── abort
│   ├── Tool Result / 按 Provider 需要整理消息链
│   └── NEED_MORE_INFO
│
├── Invocation 2
│   ├── Additional Context
│   ├── Model Call
│   ├── runActor
│   ├── submit
│   ├── Tool Result / 按 Provider 需要整理消息链
│   └── SUBMITTED
│
└── ...
```

---

# 16. 调用层级

CuetScript 固定智能 Agent 调用层级：

```text
Orchestrator
└── Writer
    └── Actor
```

禁止形成以下调用：

```text
Actor → Writer
Actor → Orchestrator
Writer → Orchestrator Agent
```

Writer 需要 Orchestrator 介入时，只能调用：

```text
abort(...)
```

结束当前 Writer Invocation，并将控制权交回外层 Orchestrator。

---

# 17. Status System

## 17.1 定义

`Status` 表示故事当前时点的规范事实。

适合写入 Status 的内容包括：

- 人物当前性格；
- 当前身份；
- 当前身体结构；
- 当前身体状态；
- 当前衣着；
- 当前姿势；
- 物体状态；
- 物体位置；
- 地点状态；
- 人物关系；
- 当前 Scene；
- 已经发生并持续有效的世界变化。

Status 不表示未来计划。

---

## 17.2 Status Tree

所有 Status 在逻辑上组成 Status Tree。

例如：

```text
Story
├── Characters
│   ├── Master
│   └── Neko
├── Objects
├── Locations
├── Relationships
├── World
├── Scene
└── Timeline
```

Status Tree 不要求固定业务 Schema。

不同角色、物种和世界可以具有不同结构。

---

## 17.3 世界事实、角色认知与公开范围

事实是否已经成立，与谁知道该事实，是两个独立维度。已确定但尚未揭露的幕后事件属于隐藏的 Canon；仅考虑采用的幕后解释属于 Notebook。

角色认知可以记录在 Character Status 的开放节点内，内容使用自然语言并允许误解、怀疑、遗忘与刻意隐瞒。角色相信某事是角色认知事实，不代表其相信的内容是世界事实。

| 内容 | 归属 |
| --- | --- |
| 钥匙实际在柜子里 | 物体或场景 Status |
| 喵子相信钥匙在主人身上 | 喵子的认知状态 |
| 主人知道钥匙在柜子里 | 主人的认知状态 |
| 作者考虑让钥匙被偷走 | Notebook |
| 钥匙已被偷走但尚未揭露 | 隐藏的 Canon |

不要求为每件小事维护完整认知图谱。涉及剧情关键反应的信息应明确记录认知主体和依据；缺失记录表示未知，不能自动推断知情或不知情。

公开范围通过引用 Status Document / Status Path、Lore 条目或 History 片段的上下文元数据表达，至少区分作者层、指定角色与公开可知范围。元数据随规范内容一同版本管理，不增加固定物种 Schema。角色认知更新由 Orchestrator 随剧情生成 Transaction。

Gateway 只向 Actor 提供授权视角内的信息；范围不明确且可能影响关键反应时请求补充。用户作为作者查看本地资料的权限，与角色在故事内的知情范围分别处理。

---

# 18. 角色表示

角色卡视为角色的 `Initial Status`。

例如：

```text
喵子
├── 基本信息
│   ├── 性别：女性
│   └── 称呼：喵子
│
├── 性格
│   ├── 娇俏
│   ├── 灵动
│   ├── 狡黠
│   └── 占有欲较强
│
├── 对主人的态度
│   ├── 深度依恋
│   ├── 高度信任
│   └── 希望获得持续关注
│
├── 关系特点
│   ├── 日常黏人
│   ├── 主动撒娇
│   └── 接受两人私下的轻度上下位互动
│
└── 身体
    └── ...
```

主人：

```text
主人
├── 性格
│   ├── 理智
│   ├── 温柔
│   └── 包容
│
├── 对喵子的态度
│   ├── 深爱
│   ├── 愿意包容大部分小任性
│   └── 不以关系角色压迫对方
│
└── 关系定位
    └── “主人”为两人私下使用的亲密称呼
```

角色在故事中发生变化时修改 Current Status。

Initial Status 保持不变。

---

# 19. Initial Status 与 Story Status

创建 Story 时：

```text
Initial Status
+ Story Initialization Patch
= Story Initial Status
```

Story Initialization Patch 可以包含：

- 当前年龄；
- 当前关系；
- 当前地点；
- 当前衣着；
- 故事起始背景；
- Story-specific 信息。

故事继续发展后：

```text
Current Status
=
Initial Status
+ Story Initialization
+ Story Changes
```

实现中可以直接维护物化后的 Current Status。

历史版本由 Git 保存，不要求运行时反复重放所有 Patch。

---

# 20. 开放式角色结构

Status 不假设角色具有标准人类结构。

猫娘可以表示为：

```text
身体
├── 人类主体结构
├── 猫耳
│   └── ...
└── 尾巴
    └── ...
```

残疾角色可以表示为：

```text
身体
├── 左腿
│   └── 状态：缺失
└── 假肢
    └── ...
```

人造人可以表示为：

```text
身体
├── 主体结构
├── 能源系统
├── 人工皮肤
└── 感知系统
```

不为特定物种、身体差异或身份类型建立独立固定 Schema。

---

# 21. Status Document

## 21.1 存储格式

Status Document 使用 YAML 1.2 的 JSON-compatible 子集。

允许：

```text
mapping
sequence
string
integer
float
boolean
null
```

禁止：

```text
anchors
aliases
merge keys
custom tags
complex keys
依赖 YAML 1.1 的特殊隐式类型
```

---

## 21.2 固定 Envelope

每个 Status Document 使用统一外层格式：

```yaml
schema_version: 1
id: character.neko
kind: character

status:
  name: 喵子
  sex: female

  personality:
    summary:
      - 娇俏、灵动。
      - 具有较强的占有欲。

  relationship:
    toward_master:
      summary: >
        全心依恋主人，日常表现黏人，并通过撒娇和轻度的关系角色互动确认亲密感。

  body:
    ...
```

Status Document 拒绝重复键及不能表示为 JSON 的数值；`schema_version`、`id` 和 `kind` 不能通过普通 Status Patch 改写。

固定字段只有：

```text
schema_version
id
kind
status
```

`status` 内部保持开放。

---

# 22. Status 自然语言节点

Status Tree 规定信息组织结构，但不要求所有节点转换为原子值。

允许：

```yaml
personality:
  relationship_attitude:
    summary: >
      对亲密关系具有明显占有欲，但主要表现为撒娇、黏人和确认双方关系，
      而不是人格上的控制。
```

不要求转换为数值参数。

---

# 23. Status 术语

### Status

故事当前规范状态。

### Status Tree

Status 的逻辑树结构。

### Status Document

磁盘中的一个 Status 文件。

### Status Path

Status Document 内的节点路径。

统一采用 JSON Pointer（RFC 6901）。

例如：

```text
/status/body/cat_ears/state
/status/personality/relationship_attitude
```

### Status Patch

对单个 Status Document 的修改。

统一采用 JSON Patch（RFC 6902）。

### Status Transaction

对一个或多个 Status Document 的原子修改集合。

### Initial Status

实体进入具体 Story 前的初始状态。

### Current Status

当前 Story Branch 已发布 Git HEAD 所对应的规范状态；工作区未提交修改和 Scene Draft 不属于 Current Status。

### Git Commit

故事历史版本。

不另外定义与 Git Commit 重复的 Snapshot 概念。

---

# 24. Status Patch

例如角色脱下外套：

```json
[
  {
    "op": "test",
    "path": "/status/clothing/jacket/state",
    "value": "worn"
  },
  {
    "op": "replace",
    "path": "/status/clothing/jacket/state",
    "value": "removed"
  }
]
```

`test` 可用于动作前置条件检查。

如果外套当前已经处于：

```text
removed
```

则 Patch 失败，可用于发现被正确提取并带此前置条件的重复脱衣动作。

Patch 校验只能证明修改操作有效，不能独自证明正文连续性。遗漏的动作、错误的提取以及正文内部发生后又恢复的变化，仍需叙事审核。

---

# 25. Status Transaction

跨 Status Document 的变化使用 Transaction。

例如：

```text
喵子脱下外套，并将外套放到沙发上。
```

可能同时修改：

```text
character.neko
object.neko-jacket
scene.current
```

所有 Patch 验证成功后再统一应用。

任意 Patch 失败时：

```text
Abort Transaction
```

不得留下部分更新。

---

## 25.1 变更依据与叙事审核

重要状态变化应附带最终候选正文的段落引用及简短依据，记录在 Transaction 元数据中。引用关联草稿修订或内容哈希，正文变化后重新审核，不要求将依据嵌入每个 Status 节点。

区分当下情绪、近期关系表现和长期人格。一次争吵不能自动推导永久人格变化；角色台词可能是谎言或猜测，不能直接提升为世界事实。

验证包含两层：

- 操作验证：路径、允许类型、前置条件、不可修改字段与跨文档完整性；
- 叙事审核：变化是否由正文支持，是否遗漏，以及是否与既有事实连续。

冲突处理顺序：先排除提取错误并修正 Transaction；正文违反既有事实时交回 Writer 修订；用户明确要求改变既有事实时进入设定修改或 Retcon。不得通过删除必要变化或悄悄修改基础事实使校验通过。

Status Transaction 在第 37.6 节的候选区域内应用，其成功不等于 Turn Result 已发布。

---

# 26. Status 权限

Actor：

```text
Status = Read Only
```

Writer：

```text
Status = Read Only
```

Writer 可以在正文或 Writer Result 中指出可能发生的状态变化，但不能直接修改 Canonical Status。

Orchestrator：

```text
具有逻辑写权限
```

Orchestrator 负责生成 Status Transaction。

Status Tool：

```text
具有物理写权限
```

执行流程：

```text
Orchestrator
→ Status Transaction
→ Status Tool
→ Validate
→ 在候选区域 Apply
→ Turn Result 验证与 Git 发布
```

---

# 27. Lorebook

Lorebook 保存世界背景知识。

职责区别：

```text
Status
= 当前故事事实

Lore
= 世界背景知识和一般设定
```

CuetScript 不采用 SillyTavern 式关键词激活机制。

Lorebook 使用 RAG。

---

# 28. LoreEntry

Lore 条目采用最小结构：

```text
id
title
content
```

例如：

```yaml
id: white-tower-access
title: 白塔访问制度
```

正文：

```text
白塔原则上不对普通外部人员开放。

获得正式访问授权的人员可以……
```

不要求维护：

```text
tags
aliases
activation keys
secondary keys
priority
insertion depth
```

---

# 29. Lorebook RAG

计划使用 SiliconFlow API 提供的：

```text
Qwen/Qwen3-Embedding-8B
Qwen/Qwen3-Reranker-8B
```

Lore 索引文本为：

```text
{title}

{content}
```

`id` 只用于程序引用，不参与 Embedding。

---

## 29.1 查询流程

```text
Orchestrator
↓
生成 Lore Query
↓
Embedding
↓
Vector Search Top-K
↓
Reranker
↓
Top-N LoreEntry
↓
Orchestrator 读取结果
↓
选择相关内容
↓
注入 Writer / Actor
```

Query 由 Orchestrator 生成。

RAG 本身只处理检索，不负责理解剧情或决定最终注入内容。

---

## 29.2 LoreRepository

最小接口：

```text
add(entry)
update(entry)
delete(id)
get(id)
search(query)
```

`search()` 内部执行：

```text
Query Embedding
→ Vector Recall
→ Rerank
```

不实现额外 Lorebook 规则引擎。

---

## 29.3 Lore 访问权限

只有 Orchestrator 可以直接查询 Lorebook RAG。

Writer 和 Actor 不直接调用 RAG。

Orchestrator 根据当前任务向其提供必要 Lore。

---

# 30. Notebook

Notebook 保存非 Canon 的作者层剧情信息。

适合记录：

- 后续剧情方向；
- 人物长期发展计划；
- 暗线；
- 暗示；
- 待回收伏笔；
- 尚未确定为事实的候选幕后解释；
- 候选剧情；
- 当前叙事意图。

例如：

```text
喵子当前仍整体偏弱下位。

后续可以逐渐增加其主动性，并使两人的关系动态发生变化。
变化应通过长期相处逐步形成，不进行突然的人格反转。
```

该内容不属于 Current Status。

---

## 30.1 Notebook 权威级别

Notebook 不是 Canon。

因此：

```text
Current Status / Committed History > Notebook
```

Notebook 中计划发生的事件不得提前写入 Current Status。

---

## 30.2 Notebook 权限

Orchestrator：

```text
Read / Write
```

Writer：

```text
默认不直接读取完整 Notebook
```

Orchestrator 可以将相关规划转换为 Writer 可使用的自然语言指导。

Actor：

```text
默认不可访问 Notebook
```

避免将作者层未来信息泄漏给角色。

用户可通过 UI 或文件直接查看和编辑 Notebook。

---

## 30.3 Notebook 存储

Notebook 使用普通 Markdown。

MVP 可以只维护：

```text
notebook.md
```

例如：

```markdown
# 当前剧情方向

……

# 暗线

……

# 待回收内容

……

# 后续候选剧情

……
```

Notebook 不要求固定 Schema。

---

## 30.4 Notebook 兑现

Notebook 中的剧情计划实际发生后：

```text
Notebook Plan
↓
Writer 写出剧情
↓
Orchestrator 审核候选正文
↓
准备正文、Status Patch 和 Notebook 修改
↓
整体发布 Turn Result
↓
History / Status 成为事实，Notebook 同步更新
```

Notebook 保存计划，History 和 Status 保存已经发生的结果。

---

# 31. History 与 Memory

## 31.1 History / Prose

History 保存已经提交的原始正文。

History 属于 Canonical Story Data。

---

## 31.2 Memory

Memory 从 History 中提取长期相关信息，例如：

- 重要人物经历；
- 关系变化；
- 对当前剧情仍有影响的旧事件；
- 长期事件摘要。

Memory 属于派生数据。

发生信息偏移时，可以从 History 重新生成。

---

# 32. 信息分类

系统统一使用以下信息分类：

| 类型              | 含义                          |
| ----------------- | ----------------------------- |
| `Status`          | 当前世界事实                  |
| `Lore`            | 世界背景知识                  |
| `History / Prose` | 已经发生的原始剧情            |
| `Memory`          | 从 History 提取的长期相关信息 |
| `Notebook`        | 尚未成为事实的剧情规划        |

权威关系为：

```text
Current Status > Initial Status

Committed History / Current Status > Notebook

Canonical Data > Memory
```

当一般 Lore 与具体 Story Instance 的 Current Status 冲突时，以 Current Status 为准。

---

# 33. Context Assembly

## 33.1 Orchestrator Context

Orchestrator 可以访问：

- Current Status；
- Initial Status；
- History；
- Memory；
- Lorebook RAG；
- Notebook；
- 用户输入；
- Git 状态；
- Writer Result；
- 本地工具。

---

## 33.2 Writer Context

Writer 可以接收：

- 已有正文；
- 当前 Scene Status；
- 相关 Character Status；
- 用户 RP 输入；
- Direction；
- Author Note；
- Orchestrator 写作要求；
- 相关 Lore；
- Orchestrator 从 Notebook 提取的必要指导；
- ActingResult；
- Writing Examples；
- Do / Don't；
- 语言重复提示。

Writer 不直接读取完整 Lorebook 或完整 Notebook。

---

## 33.3 Actor Context

Actor 可以接收：

- 传统角色 RP Prompt；
- Current Character Status；
- 相关 History；
- 角色可知信息；
- Current Scene Status；
- 当前刺激；
- 从当前 Scene Draft 中选取的角色可观察片段与场景进展；
- Suggested Action；
- Output Requirements。

Actor 不维护 Session。

---

# 34. 用户输入类型

UI 可以将用户输入分为：

### Roleplay

角色实际行为和台词。

### Direction

剧情方向控制。

### Author Note

文风、长度、场景密度和生成方式等要求。

### OOC

系统级交流。

例如：

```text
Roleplay:
主人摸了摸喵子的头。

Direction:
当前继续停留在客厅，不要转场。

Author Note:
增加这部分的对话密度。
```

输入类型由 UI 显式提供时，Orchestrator 无需自行推测其用途。

## 34.1 用户角色控制权

Story 初始化时确定用户控制的角色、默认代写范围，以及行为宣告和结果宣告的处理规则。每轮 `runWriter()` 必须携带这些约束与本轮覆盖指令。

默认不替用户控制的角色作出重要选择、补写内心决定或擅自代答。用户可明确授权轻微动作、台词或完整互动的代写范围。

“我试着推开门”表示尝试，不保证成功；“门被我推开了”是否直接成立，由故事控制规则决定。输入被保存为 Input Commit，只证明用户提出了该输入，不意味着其中所有事件已经成为 Canon。

每轮任务指定允许推进的范围与必须停下的决策点。停止条件为：完成当前叙事目标，或到达需要用户作出有意义回应的节点，以先到者为准。

---

# 35. Writer Loop

文本长度不主要通过：

```text
至少生成 2000 字
```

等固定字数限制控制。

Orchestrator 根据场景完成情况决定是否再次调用 Writer。

```text
runWriter
↓
Writer 生成
↓
submit
↓
Orchestrator 检查
├── 已完成或到达用户决策点 → 准备 Turn Result
└── 未完成且预算允许 → 再次 runWriter
```

Orchestrator 可以控制：

- 是否允许转场；
- 是否允许时间跳跃；
- 是否允许引入新角色；
- 当前冲突是否允许解决；
- 本轮剧情推进范围；
- 文本密度；
- 文风；
- 戏剧强度。

---

# 36. 语言模式控制

Writer 可以接收：

- Writing Examples；
- Do / Don't；
- 高频词统计；
- 近期语言模式提示。

例如：

```text
近期正文中过度使用“轻轻”“微微”“低声”。

减少同类副词式对话标签。
必要时使用动作、停顿或省略对话标签。
```

不建议简单禁止特定单词，以避免产生机械的同义词替换。

控制目标是重复语言模式。

---

# 37. Git 版本管理

故事目录直接使用 Git。

CuetScript 不另行实现版本控制系统。

Git 已提供：

```text
commit
branch
switch
checkout
diff
tag
log
worktree
```

可直接用于 Story Revision 管理。

---

## 37.1 Commit

一次用户交互至少可以产生：

```text
Turn Input Commit
Turn Result Commit
```

例如：

```text
当前 HEAD
↓
写入用户输入
↓
git commit
↓
Agent 执行
↓
写入正文、Status、Notebook 等修改
↓
git commit
```

当前 HEAD 已表示用户输入前的版本，因此不另行实现 Snapshot。

---

## 37.2 Regenerate

默认从目标 Turn 的 Input Commit 创建新 Story Branch，保留同一用户输入并生成新结果。旧结果与旧分支保留。

---

## 37.3 Retcon

从需要修改内容之前的历史点创建新 Branch，明确要修改的是用户输入、正文还是设定，再从该位置重新推进。分叉点之后的旧 Session 内容不得继承。

---

## 37.4 IF Story

IF 路线直接使用 Git Branch。

---

## 37.5 Tag

重要剧情节点可以使用 Git Tag。

---

## 37.6 Turn Result 的提交边界

Turn Result 是故事接受的整体单位，至少包含最终正文、Status 变化、必要的 Notebook 修改、知情范围元数据以及本轮接受结果与 Session 恢复位置。Input / Result Commit 通过版本化元数据记录 `turn_id`、提交类型和基础版本。

```text
生成 Scene Draft
→ 审核并冻结候选修订
→ 隔离准备 Turn Result
→ 验证全部规范内容
→ 创建 Result Commit
→ 在预期分支基础版本上发布
→ 已接受
```

正文、状态及 Notebook 修改在隔离工作区或候选树中准备。运行时按分支串行接受结果，检查分支仍指向预期基础 Commit 后发布；基础版本变化时保留候选结果，返回版本冲突，不覆盖外部修改。

Git 提供版本对象和引用更新，但不自动保证普通工作区多文件写入原子性。Runtime 读取已发布 Commit 的一致内容，或在受控锁下完成工作区同步，不能在发布过程中向其他请求暴露半套文件。用户已有的未提交文件不作为可随意覆盖的暂存区。

结果发布规则：

- Result Commit 未发布：本轮未接受，可恢复准备过程或保留草稿等待处理；
- Result Commit 已发布、返回用户前中断：恢复时展示已有结果，不重新执行输入；
- 相同接受操作重试：根据 Turn / Invocation / 接受操作标识返回持久化结果，不重复追加正文或应用变化；
- 基础版本冲突：显式重新审核或重新生成，不能自动把旧 Transaction 应用到新版本。

Memory、Embedding 与检索索引在发布后按源内容版本更新。派生数据失败不撤销 Canon；索引记录源版本、内容哈希、模型及索引配置。源版本不匹配时重建或回退读取原始材料，不能静默使用其他分支的旧索引。

完整运行日志与未接受草稿单独持久化，不因为不属于 Canon 而删除。Result Commit 保存与已接受结果对齐的恢复记录及必要日志引用；日志不得引用自己的未来 Commit 哈希形成循环依赖。恢复日志重放仍须遵守第 13 节工具结果补全规则。

---

# 38. Agent Session 与 Git Branch

Orchestrator 和 Writer 的逻辑 Session 与 Story Branch 对齐。

未发生 Fork 时：

```text
Orchestrator Session = 单线
Writer Session       = 单线
```

Fork 后，不同 Branch 具有独立的逻辑 Session：

```text
Main
├── Orchestrator Session A
└── Writer Session A

Alternative
├── Orchestrator Session B
└── Writer Session B
```

Agent Session 是 CuetScript 的本地概念，不依赖 Provider 的远程 Conversation ID。

## 38.1 执行记录与有效上下文

Session 分为完整执行记录和当前有效上下文。执行记录保留请求、工具调用、候选结果、审核与失败；有效上下文是下一次请求实际使用的信息，可筛选、压缩或重建。

同一轮修订和补充信息通常延续上下文；一轮接受后，以最终正文和当前事实组织后续请求。被否决正文与未采用 Actor 表演不进入后续常规上下文，也不自动成为 Memory。明确的用户创作禁忌可独立保留。

逻辑 Session 持续不要求 API 历史无限追加。文风要求、写作样例和未完成目标可以保留，但已过时的状态必须替换；上下文重建记录其来源版本。

Fork 只继承分叉点之前的有效信息。Input Commit 上的恢复位置允许重新执行该输入；Result Commit 上的恢复位置指向已经接受的结果，不能重复消费同一输入。

---

# 39. Provider Adapter

不同 Provider 对以下内容的实现不同：

- Tool Call；
- Tool Result；
- Reasoning；
- 历史消息；
- Prompt Cache；
- Token 统计；
- API 错误。

CuetScript 使用 Provider Adapter 隔离这些差异。

例如：

```text
OpenAIAdapter
DeepSeekAdapter
GeminiAdapter
...
```

Runtime 只处理统一逻辑：

```text
Assistant Message
Tool Call
Tool Result
Model Resume
```

Provider Adapter 负责：

- API 请求序列化；
- Tool Call 格式；
- Provider-specific 历史字段；
- Reasoning replay data；
- Prompt Cache；
- Token 统计；
- 错误码转换。

持久 Agent 历史必须记录每个 Tool Call 的执行结果或可恢复的中断状态。重放前补齐对应 Tool Result，业务提交与可选 Closing Model Call 的恢复规则见第 13 节。

---

# 40. Cache 策略

## 40.1 Orchestrator

Orchestrator 是持续 Agent，包含较多稳定系统信息。

可针对 Provider 设计缓存和上下文布局。

---

## 40.2 Writer

Writer 同样具有持续 Session。

同一 Story Branch 或场景中的稳定上下文可以参与缓存优化。

---

## 40.3 Actor

Actor 不针对缓存建立 Session。

```text
Cache Hit
= 成本或延迟优化

Cache Miss
= 正常执行
```

Actor Prompt 只要求提供充分的当前表演信息。

---

# 41. 模型选择

不同模型槽位分别测试。

## 41.1 Orchestrator

主要测试：

- Agentic 能力；
- Tool Calling；
- 长上下文；
- 信息检索；
- Status 理解；
- 指令遵循；
- 成本。

---

## 41.2 Writer

主要测试：

- 长文本生成；
- 文风稳定性；
- 场景结构；
- ActingResult 整合；
- Writer Session 连续性；
- 重复模式；
- 上下文利用能力。

---

## 41.3 Actor

主要测试：

- 传统 RP 表现；
- 角色设定遵循；
- 台词自然度；
- 多角色语言差异；
- Current Status 利用；
- 单次请求的上下文理解。

Actor 不要求与角色绑定固定模型。

---

# 42. 本地目录

建议的 Story 目录结构：

```text
story/
├── status/
│   ├── characters/
│   ├── objects/
│   ├── locations/
│   ├── relationships/
│   ├── world/
│   └── scene/
│
├── lore/
│
├── prose/
│
├── memory/
│
├── notebook.md
│
├── user-input/
│
├── prompts/
│   ├── orchestrator/
│   ├── writer/
│   └── actor/
│
├── sessions/
│   ├── orchestrator/
│   └── writer/
│
├── config/
│
├── runtime/              # 执行日志、草稿与恢复记录，不作为 Canon
│
├── cache/                # 可重建派生索引，不纳入故事版本
│
└── metadata/
```

目录布局用于本地管理，不构成 Status Schema。`sessions/` 保存随故事版本管理的有效恢复记录；`runtime/` 保存完整执行日志与未接受草稿，独立持久化并排除在故事提交之外；`cache/` 可重建。完整备份应同时包含 Git 故事历史和运行记录。

---

# 43. CLI

命令行程序名称统一为：

```text
cuet
```

具体命令接口尚未定型。

Git 继续负责底层版本管理，不在 `cuet` 内重复实现 Git 的数据模型。

`cuet` 后续可封装常用操作，例如 Story 启动、模型调用、Status 检查和 Story Branch 管理，但具体 CLI 命令属于后续接口设计内容。

---

# 44. 完整生成流程

一次包含 Actor 调用的完整 Turn 可以表示为：

```text
User Input
↓
写入本地
↓
Git Commit
↓
Orchestrator Model Call
↓
解析输入
↓
查询 Status
↓
必要时查询 Lorebook RAG
↓
必要时读取 Notebook / Memory / History
↓
tool_call runWriter(...)
↓
Orchestrator 暂停
↓
Writer Invocation
↓
Writer Model Call
↓
需要角色表演
↓
tool_call runActor(...)
↓
Actor Gateway 构造 ActingTask
↓
Actor Model Request
↓
ActingResult
↓
tool_result 返回 Writer
↓
Writer 继续
↓
必要时再次 runActor
↓
Writer 调用 submit(...) 或 abort(...)
↓
返回 Tool Result
↓
按 Provider 需要整理 Writer 消息链
↓
runWriter() 返回
↓
Orchestrator 恢复
```

当结果为：

```text
NEED_MORE_INFO
```

执行：

```text
Orchestrator 查询或整理缺失信息
↓
再次 runWriter(...)
↓
恢复同一 Writer Session
```

当结果为：

```text
SUBMITTED
```

执行：

```text
Orchestrator 审核正文
↓
必要时再次调用 Writer
↓
冻结最终候选正文与草稿修订
↓
生成带正文依据的 Status Transaction
↓
在隔离候选区域验证并应用
↓
准备正文、Notebook 修改和 Session 恢复记录
↓
整体验证 Turn Result
↓
形成 Result Commit 并发布到预期分支
↓
标记结果已接受并返回用户
↓
按已发布版本更新 Memory / 检索索引
```

---

# 45. 工具权限

## 45.1 Orchestrator

可使用：

```text
runWriter
status.*
lore.search
history.*
memory.*
notebook.*
git.*
filesystem.*
```

实际工具集合由实现阶段确定。`filesystem.*`、`git.*` 等工具必须经过 Runtime 的路径范围和结果发布约束，不能绕过第 37.6 节直接修改已发布 Canon。

---

## 45.2 Writer

主要使用：

```text
runActor
submit
abort
```

Writer 不直接修改 Canonical Story Data。

---

## 45.3 Actor

默认不提供工具。

```text
Actor Tools = none
```

Actor 只执行一次角色扮演请求。

---

# 46. 运行时错误边界

以下情况属于协议错误或运行时错误，而不是正常剧情结果：

- Writer 多次纠正后仍未调用 `submit()` 或 `abort()`；
- Tool Call 缺少对应 Tool Result；
- Status Transaction 仅部分成功；
- Provider 返回无法恢复的非法消息结构；
- Writer 或 Orchestrator Session 与当前 Story Branch 不一致；
- Actor 请求无法构造必要角色上下文。

Runtime 应区分业务状态和系统错误。

例如：

```text
submitted
need_more_info
```

属于正常业务结果。

```text
agent_protocol_failure
provider_error
status_transaction_failure
```

属于系统错误。

---

## 46.1 整轮预算与中断

Runtime 为单轮设置 Model Call 总数、Actor 重试、Writer 修订、补充信息往返、Token / 成本及耗时预算。费用不可精确获得时记录估计值，不能将缺失统计视为零成本。模型层重试计入同一预算。

达到预算或用户取消时停止继续编排，保存候选正文、执行记录与恢复位置，并返回未完成原因。未完成的草稿不得自动成为 Canon。已发布结果则按已接受状态恢复。

除业务结果外，明确区分 `budget_exceeded`、`cancelled`、`version_conflict` 和可恢复的会话尾部整理失败。网络重试不能越过已经成功持久化的业务结束或结果发布边界。

---

# 47. 信息偏移控制

CuetScript 不假设长期信息压缩可以完全避免偏移。

主要控制方式包括：

- 保存原始 History；
- 保存 Initial Status；
- 维护 Current Status；
- Memory 允许重新生成；
- Lore 保存原始文本；
- Notebook 与 Canon 分离；
- 上下文按需检索；
- Git 保存 Story Revision。

长期运行不依赖不断进行“摘要的摘要”。

---

# 48. 系统定义汇总

CuetScript 使用以下组件：

```text
Orchestrator
= 持续的故事控制 Agent

Writer
= 持续的长文本写作 Agent

Actor
= 无状态、一次性的 Roleplaying 请求

Status
= 当前规范事实

Lore
= RAG 世界背景知识

History
= 已经发生的原始剧情

Memory
= 从 History 生成的长期相关信息

Notebook
= 非 Canon 的剧情规划、暗线和伏笔记录

Git
= Story Revision、Branch 和历史版本系统

cuet
= CuetScript CLI
```

Orchestrator 和 Writer 在单个 Story Branch 上保持持续 Session。Actor 每次调用独立执行。

Orchestrator 通过 `runWriter()` 委派写作。Writer 通过 `runActor()` 按需请求角色表演，并使用 `submit()` 或 `abort()`结束一次 Writer Invocation。Tool Call 必须有对应 Tool Result；Closing Model Call 按 Provider 协议需要执行，其失败不得撤销已持久化的业务提交。

Status 使用开放式 Status Tree。Status Document 使用 YAML 1.2 的 JSON-compatible 子集；JSON Pointer 用于节点寻址；JSON Patch 用于修改；Status Transaction 用于跨文档原子更新。

Lorebook 使用 `id`、`title` 和 `content` 组成 LoreEntry，通过 Embedding、Vector Search 和 Reranker 进行语义检索。只有 Orchestrator 可以直接执行 Lore 查询。

Notebook 保存尚未成为事实的剧情规划、暗线和待回收内容，由 Orchestrator 管理。

故事目录由 Git 直接管理。Regenerate、Retcon、IF Story 和历史恢复均使用 Git Commit 和 Branch。

---

# 49. 最小验证范围与待验证假设

三层调用提供职责分离，但其文学收益和成本收益仍须实测。首先用同一批场景、相同设定、方向与写作要求，对照 Writer 单独写作和 Writer 调用 Actor；记录实际模型配置、输入、输出、调用次数、延迟与成本。

评议角色辨识度、Actor 意图在最终正文中的保留、场景流畅性、连续性错误与用户控制权。尽可能隐藏方案身份并进行多次独立采样；不以单次偏好或“成功调用了 Actor”作为架构收益证明。

最小验收场景包含：

| 场景 | 预期行为 |
| --- | --- |
| 同轮脱下外套后再次表演 | 使用草稿变化，Canon 在结果发布前保持原状 |
| 角色持有错误认知，旁白掌握真相 | 保留误解，不向 Actor 注入越界事实 |
| Actor 候选被拒绝，或前文被改写 | 后续上下文不沿用废稿，依赖结果失效或显式重新采纳 |
| 一次情绪冲突 | 不自动改写长期人格 |
| 场景到达用户关键选择 | 停止并交还用户，不为凑长度代答 |
| 候选区域状态更新后写入失败 | 已发布故事不出现部分结果 |
| Result Commit 发布后进程中断 | 恢复已有结果，不重复生成或追加 |
| 从历史输入重新生成并切换分支 | 保留原输入，隔离未来 Session 和派生索引 |
| Closing Model Call 失败或预算耗尽 | 保留已持久化业务结果，未接受草稿不提升为 Canon |

协议、事务与恢复需用确定性故障注入验证；角色表现与知情边界需用真实模型和完整输入输出评议。前者通过不能替代后者。

MVP 优先完成串行 Actor、单分支结果发布、草稿修订和真实场景闭环，再验证分支恢复。Actor 并行、复杂模型路由和专用向量服务后置。本文不新增审核 Agent，不要求知识图谱或固定心理数值。
