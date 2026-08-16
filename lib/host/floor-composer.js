const QWEN_MODELS = new Set(['qwen3.5-flash', 'qwen3.6-flash', 'qwen3.7-flash']);
const OPENAI_MODELS = new Set(['gpt-5-mini', 'gpt-5-nano']);
const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
export async function composeFloorText(input, key, signal) {
    const instruction = systemInstruction(input.stage, input.previousCues);
    let raw;
    if (input.provider === 'qwen') {
        if (!WORKSPACE_RE.test(input.workspaceId) || !QWEN_MODELS.has(input.model))
            throw new Error('invalid floor composer configuration');
        const endpoint = `https://${input.workspaceId}.${input.region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
        const response = await fetch(endpoint, {
            method: 'POST', signal,
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                model: input.model,
                messages: [{ role: 'system', content: instruction }, { role: 'user', content: `主题：${input.topic}` }],
                temperature: 0.9,
                max_completion_tokens: 48,
                enable_thinking: false,
            }),
        });
        if (!response.ok)
            throw new Error(`floor provider rejected request (${response.status})`);
        const body = await response.json();
        raw = body.choices?.[0]?.message?.content;
    }
    else {
        if (!OPENAI_MODELS.has(input.model))
            throw new Error('invalid floor composer configuration');
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST', signal,
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: input.model, instructions: instruction, input: `主题：${input.topic}`, max_output_tokens: 48 }),
        });
        if (!response.ok)
            throw new Error(`floor provider rejected request (${response.status})`);
        const body = await response.json();
        raw = body.output_text ?? body.output?.flatMap(item => item.content ?? []).find(item => item.type === 'output_text')?.text;
    }
    const cue = validateFloorCue(raw);
    if (cue === undefined)
        throw new Error('floor provider returned unsafe text');
    return cue;
}
export function cleanFloorTopic(value) {
    if (typeof value !== 'string')
        return '';
    const cleaned = value
        .replace(/<!--[^]*?-->/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\b(?:sk|key|token)-[a-z0-9_-]+\b/gi, ' ')
        .replace(/\b(?:gh[pousr]_[a-z0-9]+|github_pat_[a-z0-9_]+|A(?:KI|SI)A[0-9A-Z]{16})\b/gi, ' ')
        .replace(/\bBearer\s+\S+/gi, ' ')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
        .replace(/\b(?:[a-f0-9]{32,}|[a-z0-9+/]{24,}={0,2})\b/gi, ' ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, '')
        .replace(/[<>{}[\]`"'\\|]+/g, '')
        .slice(0, 18);
    return cleaned.length >= 2 ? cleaned : '';
}
export function validateFloorCue(value) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim().replace(/\s+/g, ' ');
    if (text.length < 3 || text.length > 60 || /[\r\n]/.test(value))
        return undefined;
    if (/https?:|www\.|@|```|[#*_{}[\]<>]|(?:sk|token|key)-|Bearer/i.test(text))
        return undefined;
    if (/^(?:\{|\[)|(?:答案|结果|结论)(?:是|为)|已经(?:查到|完成|处理好)/.test(text))
        return undefined;
    const first = text.match(/^.*?[。！？!?]/)?.[0] ?? text;
    return first.length >= 3 && first.length <= 60 ? first : undefined;
}
function systemInstruction(stage, previous) {
    const stageRule = {
        ack: '自然承接用户，表示你正在继续听和看。',
        tool: '只表示正在等外部步骤返回，不声称已经获得数据。',
        retry: '自然说明刚才那一步正在重试，不暴露错误细节。',
        'long-wait': '用户等得较久，温和陪伴并说明结果一到就继续。',
    };
    return `你是实时语音助手的“嘴巴层”，不是回答问题的脑子。${stageRule[stage]}只输出一句自然中文口语，8到28个汉字；不要回答主题、给事实、建议、数字、链接或承诺结果；不要复述固定套话；不要输出标题、解释、标记或引号。此前已经说过：${previous.slice(-3).join(' / ') || '无'}。必须换一种自然表达。`;
}
