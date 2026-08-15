export const VOICE_SUMMARY_START = '<!--voice-summary-->'
export const VOICE_SUMMARY_END = '<!--/voice-summary-->'

/**
 * Model-visible system context, materialized by Harness as a plugin-source
 * snapshot. It is never concatenated with the user's visible transcript.
 */
export const VOICE_OUTPUT_CONTEXT = `本轮由实时语音发起。所有工具调用和推理完成后，最终可见回答必须按自然、好看的正文结构输出：
第一自然段就是可直接播报的口语开场，只写一至两句、中文不超过120字；直接说结论或最重要的信息，不写标题、列表、代码、链接、推理过程、“总结如下”等套话，也不要输出任何 HTML 注释、XML 标签、机器边界或 voice-summary 字样。
在最终回答之前不要输出任何可见正文；需要调用工具时直接调用工具，不要先写“我查一下”等过渡文字。
第一段后空一行，再按任务需要继续完整结果；简单问题不必重复扩写，复杂任务保留必要细节。第一段必须同时是正文的一部分，后文不要原样重复。若前面可能已有语音承接，第一段直接进入结论，不再重复“我看看”“我想想”“我来处理”等等待话术。`
