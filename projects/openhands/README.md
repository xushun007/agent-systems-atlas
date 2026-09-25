# OpenHands

- Repository: https://github.com/OpenHands/OpenHands
- Analyzed version: `v1.15.0`
- Remote ref: [`v1.15.0`](https://github.com/OpenHands/OpenHands/tree/v1.15.0)
- Analyzed commit: [`ab23be62ad724fe83483036a0900bed7b7859166`](https://github.com/OpenHands/OpenHands/commit/ab23be62ad724fe83483036a0900bed7b7859166)
- Backend SDK: `OpenHands/software-agent-sdk@v1.15.0`, commit [`3635cda1d62f961e8d6a4f5a8f05a3aaa72d8ad2`](https://github.com/OpenHands/software-agent-sdk/commit/3635cda1d62f961e8d6a4f5a8f05a3aaa72d8ad2)
- Reviewed: 2026-09-15

## 内容

- [Harness / Runtime 演进研究](research/openhands-harness-evolution.md)
- [Runtime 业务流程图（Excalidraw）](diagrams/openhands-runtime-architecture-v1.15.0-ab23be6.excalidraw)

本仓库是 OpenHands Agent Canvas 前端。Agent loop、工具执行、Conversation 状态机和 Agent Server API 的服务端实现位于 [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)；研究中会明确标注两者边界。
