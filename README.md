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

## Web 界面与手机访问

完成 `npm ci` 和 `npm run build` 后，在项目目录启动：

```sh
npm run web
```

打开终端显示的本机链接即可。默认监听 `127.0.0.1:3210`，每次启动生成访问口令；带 `#token=...` 的本机链接会自动连接，口令只保存在当前浏览器标签页会话中。

Web 服务默认管理 `./stories/` 下的独立故事仓库。可以直接在网页创建示例故事，或使用 `--stories-dir /path/to/stories` 指向已有故事的父目录。故事目录名称使用英文、数字、`-`、`_`，不支持软链接。不会扫描其他位置或搬动已有故事。

本机约定路径存在时，会自动读取以下外部配置（不复制到故事或源码）：

- `~/.config/llm-api-keys/deepseek-api-key`
- `~/.config/llm-api-keys/siliconflow-api-key`
- `~/.config/cuetscript/antigravity/`

也可通过 `--deepseek-key-file`、`--siliconflow-key-file`、`--agy-auth-dir` 覆盖；前两项对应环境变量为 `CUET_DEEPSEEK_KEY_FILE`、`CUET_SILICONFLOW_KEY_FILE`，Antigravity 沿用 `CUET_AGY_AUTH_DIR`。直接配置模型凭据环境变量也仍然可用。

网页提供：

- 角色行动、剧情方向、写作要求、OOC 输入，以及完成后的正文；输入草稿在当前浏览器会话中保存。
- 后台运行进度、停止、记录阅读、恢复（含增加时间预算与重置纠错）、在新分支重新生成。
- YAML / JSON 设定和 Notebook 编辑、创建 Lore / Status 文件、删除 Lore / Status 文件、只读查看正文。保存和删除立即生成 Git 版本，版本冲突或工作区有未提交修改时拒绝覆盖。
- 知识索引与检索、环境检查、Gemini 模型目录和真实 Provider 测试。
- 历史版本列表、创建和切换故事分支。

关闭网页不会停止后台模型运行，重新打开可重新连接正在执行的任务。关闭服务会请求停止任务；重启服务后从“运行记录”恢复。后台任务的页面缓存只在当前服务进程中保留，故事执行日志和已接受结果持久保存。账号首次导入仍使用前述本地 `auth import-dsh` 命令；网页不接收或展示服务商密钥。

手机和电脑连接同一可信局域网后，用以下方式启动：

```sh
npm run web -- --host 0.0.0.0
```

手机打开终端显示的“局域网”地址，并输入访问口令。手机页面使用单列布局和可横向滑动的导航。该服务是个人工作台，口令拥有读取故事、修改设定和调用模型的权限；当前使用 HTTP，请勿直接暴露到公网。需要远程访问时应另行配置 HTTPS 或私有网络。

可用 `--port 3211` 修改端口，用 `CUET_WEB_TOKEN` 环境变量固定访问口令。终端按 Ctrl+C 停止服务。
