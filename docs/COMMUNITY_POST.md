# DSH｜dsh-realtime-voice｜让语音厂商负责听说，Harness 负责推理与插件调度

> 非官方项目，由社区成员独立开发和维护。

项目地址：
https://github.com/zfu691531-hash/dsh-realtime-voice

## 项目介绍

`dsh-realtime-voice` 是一个轻量的 DeepSeek Harness 实时语音插件，不带 Docker、Python 或本地模型。

国内线路使用 `Qwen ASR → DeepSeek Harness → Qwen TTS`。千问只负责流式识别和播音；空闲时完整语句经原生输入框自动交给 Harness，运行或播报期间的新语音则留在输入框等待发送或清空。推理、上下文、联网、工具和其他插件调度始终由当前 Harness 会话完成。

插件通过标准 `dsh.bundle` manifest 安装：Host 侧代理上游语音 WebSocket 并从 Harness 凭据服务读取 API Key，浏览器侧只处理麦克风、VAD、原生输入框和流式播放。Key 不进入浏览器、本地存储、包文件或日志。

## 安装

仓库按 DSH bundle 规范提交预构建产物，固定标签后一条命令安装，不需要允许 git 依赖执行构建脚本：

```bash
dsh plugin --profile web add github:zfu691531-hash/dsh-realtime-voice#v0.9.0
```

重启 Harness 后，在“设置 → 插件”配置“实时语音（千问 / GPT）”。千问需要在 Harness 凭据中提供 `DASHSCOPE_API_KEY`，并填写同区域的百炼 Workspace ID。

## 截图

![DeepSeek Harness 实时语音插件设置](https://raw.githubusercontent.com/zfu691531-hash/dsh-realtime-voice/main/screenshots/settings.png)

## 验证与边界

- 54 项 Host、协议、委派、并发、TTS、接场和摘要边界测试通过。
- 空闲首轮自动提交、忙时草稿合并保持不变；第一自然段直接作为可见且可播的简短结论，不再输出 HTML 边界标记，推理过程和详细正文不会进入 TTS。
- 实际等待超过阈值才播放一次自然承接，快回答零额外话术；Harness 轨迹发生 LLM retry 时旧播报立即失效。
- 已验证千问 ASR/TTS 的真实 WebSocket 握手。
- 当前 Harness Desktop 的 Electron 壳拒绝 renderer 麦克风权限，因此插件会在默认外部浏览器打开同一 loopback Harness 页面；会话和 Agent 仍是同一个 Harness 实例。
- 项目为 MIT 许可，与 DeepSeek AI、阿里云或 OpenAI 无隶属关系。

下一阶段会基于 Harness 的真实 tool/progress 轨迹增加至多一次可验证进度话术；不会引入第二个回答 Agent。
