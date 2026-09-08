# CuetScript

面向长期、开放式 Roleplaying 的多模型叙事系统，CLI 名称为 `cuet`。

当前处于设计阶段，尚未实现运行程序。

- [项目设计](docs/CuetScript.md)：叙事职责、状态、角色知情范围、草稿和故事版本语义。
- [技术设计](docs/technical-design.md)：Node.js 26 / TypeScript、DeepSeek 官方 API、首期完整 RAG、Antigravity 接入方案与验收。

首期必须包含 SiliconFlow Embedding、向量召回和 Reranker。Gemini Antigravity 参考 dsh-agy，真实兼容验证通过后启用。

协作时请区分已确定的设计、待实现接口与实测结果；行为规则变化应同步更新两份文档。真实故事、模型凭据与执行日志不应提交到源码仓库。
