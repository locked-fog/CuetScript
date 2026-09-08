# CuetScript

面向长期、开放式 Roleplaying 的本地多模型叙事系统，命令行名称为 `cuet`。

当前提供可运行的 **CLI 开发版**：DeepSeek 官方 API、SiliconFlow 完整 Lorebook RAG、Orchestrator → Writer → Actor、Status 审核与 Git 结果发布。Gemini Antigravity 属于实验性接入，已通过真实工具回放和 Gemini Actor 混合生成验证，尚未完成全部异常与配额场景验收。

- [项目设计](docs/CuetScript.md)
- [技术设计与当前实现边界](docs/technical-design.md)
- [2026-09-09 验收记录](docs/validation/2026-09-09.md)

## 安装与创建故事

需要 Node.js **26**、npm 和 Git。使用现有 Node 26，不自动切换版本。

```sh
npm ci
npm run check
node dist/cli/index.js init /path/to/my-story
node dist/cli/index.js --story /path/to/my-story doctor
```

`init` 创建独立的示例故事 Git 仓库；目标目录必须不存在。修改 `config/cuet.yaml`、Status、Lore 和知情范围后，在故事仓库提交自己的修改，再启动生成。Git 提交需要当前用户已配置 author identity。

配置中的三个槽位分别指定模型。默认均使用 DeepSeek；启用 thinking 时不同时设置 temperature。Story 只保存凭据的环境变量名称，不保存密钥。

## 完整 RAG 与生成

可通过环境变量 `DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY` 提供密钥，或从外部单行密钥文件读取：

```sh
node dist/cli/index.js --story /path/to/my-story \
  --siliconflow-key-file /private/siliconflow-key lore index

node dist/cli/index.js --story /path/to/my-story \
  --siliconflow-key-file /private/siliconflow-key \
  lore search '没有凭证如何申请访问白塔？'

node dist/cli/index.js --story /path/to/my-story \
  --deepseek-key-file /private/deepseek-key \
  --siliconflow-key-file /private/siliconflow-key \
  run --roleplay '我向林灯询问访问手续。' \
  --direction '解释制度后，在需要我回答时停下。' \
  --author-note '约300字，调用林灯 Actor，不替旅人作答。'
```

`run` 会先为当前 Lore 版本建立或复用索引，再执行模型编排。真实 Embedding、向量召回与 Reranker 均已接入；服务不可用时明确失败，不替换成关键词搜索。Lore 使用包含 `id`、`title`、`content` 的 YAML 文件；编辑或删除后提交，下一次重新索引。

stdout 输出结果 JSON，stderr 输出简短进度；`--quiet` 关闭进度。模型正文和派生状态仍需审阅：当前审核由模型完成，结构验证无法证明所有文学判断正确。

## 恢复与分支

```sh
node dist/cli/index.js --story /path/to/my-story turns
node dist/cli/index.js --story /path/to/my-story resume TURN_ID
node dist/cli/index.js --story /path/to/my-story \
  --deepseek-key-file /private/deepseek-key \
  --siliconflow-key-file /private/siliconflow-key \
  regenerate TURN_ID --branch alternative
node dist/cli/index.js --story /path/to/my-story branch retcon --from COMMIT
```

已接受的 Turn 可在没有密钥时重新读取，不产生新模型调用或重复提交。未完成 Turn 的恢复需要相应凭据，并且必须位于原分支、原基础版本。`regenerate` 从原 Input Commit 创建新分支，使用原输入重新生成，不继承未来的模型会话。

已耗尽时间预算可显式使用 `resume TURN_ID --additional-seconds 300`。修复程序后若要重试协议失败，可加 `--retry-protocol`；这些覆盖操作会写入本地日志，调用数与 Token 预算不会悄悄重置。

故事工作区不干净时拒绝覆盖。`runtime/` 保存不可丢弃的执行记录，`cache/` 保存可重建索引，两者不进入故事 Git；完整备份仍应包含 `runtime/`。

## Gemini Antigravity（实验性）

已授权的 dsh-agy 账号可以只读导入到独立的私有目录：

```sh
node dist/cli/index.js auth import-dsh /path/to/dsh-home /private/cuet-agy \
  --client-secret-file /private/oauth-client-secret
node dist/cli/index.js --story /path/to/my-story \
  --agy-auth-dir /private/cuet-agy provider models antigravity
node dist/cli/index.js --story /path/to/my-story \
  --agy-auth-dir /private/cuet-agy provider check antigravity --model gemini-3-flash
```

导入支持 dsh-agy 加密账号与两种主密钥配置格式，不改写原目录。OAuth 客户端 ID 从账号配置读取，也可通过 AGY_CLIENT_ID 指定；客户端 secret 通过上述外部文件或 AGY_CLIENT_SECRET 提供，源码不内置客户端凭据。目标目录必须不存在。当前不提供全新的浏览器 OAuth 登录界面；需要已有有效 dsh-agy 登录。带独立代理的账号会被明确拒绝，不绕过原代理配置。

例如仅把 Actor 配置为 Gemini，Orchestrator 和 Writer 保持 DeepSeek：

```yaml
actor:
  provider: antigravity
  model: gemini-3-flash
  thinking: true
  effort: low
  maxTokens: 2048
```

提交配置后，在 `run` 时增加 `--agy-auth-dir /private/cuet-agy`，或设置 `CUET_AGY_AUTH_DIR`。工具回放保存真实 Provider 返回片段，不使用伪造签名占位符。参数支持与错误恢复仍以 [验收记录](docs/validation/2026-09-09.md) 为准。

## 开发验证

```sh
npm run check
npm run format:check
npm pack
```

自动测试不使用真实密钥。真实 API 验收需显式调用 `provider check`、`lore index/search` 和 `run`；其中会产生模型服务用量。`scripts/verify-antigravity.mjs` 提供跨三个进程的签名回放验证。

真实故事、凭据和执行日志不要提交到源码仓库。参考 dsh-agy 的代码来源和许可见 [third-party](third-party/README.md)。
