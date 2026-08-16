# DSH｜dsh-realtime-voice｜让语音厂商负责听说，Harness 负责推理与插件调度

> 非官方项目，由社区成员独立开发和维护。

项目地址：
https://github.com/zfu691531-hash/dsh-realtime-voice

## 项目介绍

`dsh-realtime-voice` 是一个轻量的 DeepSeek Harness 实时语音插件，不带 Docker、Python 或本地模型。

国内线路使用 `Qwen ASR → DeepSeek Harness → Qwen TTS`。千问只负责流式识别和播音；空闲时完整语句经原生输入框自动交给 Harness，运行或播报期间的新语音则留在输入框等待发送或清空。推理、上下文、联网、工具和其他插件调度始终由当前 Harness 会话完成。

插件通过标准 `dsh.bundle` manifest 安装：Host 侧代理上游语音 WebSocket 并从 Harness 凭据服务读取 API Key，浏览器侧只处理麦克风、VAD、原生输入框和流式播放。Key 不进入浏览器、本地存储、包文件或日志。

v0.11 把接场升级为真正的模型生成：插件在 Harness 开始处理时并行请求当前语音供应商的轻量文本模型，只发送脱敏后的短主题、阶段枚举和此前安全接场句；健康路径不再使用固定候选话术。Harness 仍是唯一负责结论、推理和工具的“脑子”，接场句不进入历史，结果一到立即取消。v0.10 的腾讯云声纹软门控继续保留。

## 安装

仓库按 DSH bundle 规范提交预构建产物，固定标签后一条命令安装，不需要允许 git 依赖执行构建脚本：

```bash
dsh plugin --profile web add github:zfu691531-hash/dsh-realtime-voice#v0.11.0
```

重启 Harness 后，在“设置 → 插件”配置“实时语音（千问 / GPT）”。千问需要在 Harness 凭据中提供 `DASHSCOPE_API_KEY`，并填写同区域的百炼 Workspace ID。可选声纹还需要 `TENCENT_SECRET_ID` 与 `TENCENT_SECRET_KEY`；启用后首句只用于录入，之后再重复实际指令。

## 截图

![DeepSeek Harness 实时语音插件设置](https://raw.githubusercontent.com/zfu691531-hash/dsh-realtime-voice/main/screenshots/settings.png)

## 验证与边界

- 72 项 Host、协议、委派、并发、TTS、动态接场、声纹和摘要边界测试通过。
- 空闲首轮自动提交、忙时草稿合并保持不变；第一自然段直接作为可见且可播的简短结论，不再输出 HTML 边界标记，推理过程和详细正文不会进入 TTS。
- 实际等待超过阈值才动态接场，快回答零额外话术；长工具调用根据真实轨迹分阶段衔接且每轮最多三句，Harness 结果、retry、取消或连接重启会让旧播报立即失效。
- 声纹默认关闭；开启后原始 PCM 只在当前 utterance 的浏览器内存中短暂存在，Host 只保存腾讯返回的不透明 ID，密钥与 ID 都不返回浏览器。填充词不会调用声纹接口，慢声纹请求也不会阻塞 ASR 事件流。
- 已验证千问 ASR/TTS 的真实 WebSocket 握手。
- 当前 Harness Desktop 的 Electron 壳拒绝 renderer 麦克风权限，因此插件会在默认外部浏览器打开同一 loopback Harness 页面；会话和 Agent 仍是同一个 Harness 实例。
- 项目为 MIT 许可，与 DeepSeek AI、阿里云或 OpenAI 无隶属关系。

动态接场与声纹软门控均经过 Harness 创造者模式独立源码复审；真实供应商延迟、共享房间误拒率和重放攻击仍需用户按场景评估。
