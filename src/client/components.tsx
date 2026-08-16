import { useEffect, useState, useSyncExternalStore } from 'react'
import type { VoiceController } from './controller.ts'
import { loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'
import { deleteVoiceprint, getVoiceprintStatus, type VoiceprintStatus } from './voiceprint.ts'

const styles = {
  button: { width: 32, height: 32, border: 0, borderRadius: 999, cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-secondary)', background: 'transparent' },
  active: { color: '#fff', background: '#2563eb' },
  dock: { margin: '0 auto 4px', maxWidth: 760, padding: '5px 12px', borderRadius: '10px 10px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-specific-tip)' },
  continueDock: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' },
  continueTitle: { flex: 'none', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  card: { listStyle: 'none', padding: '14px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  row: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, alignItems: 'center', marginTop: 10 },
  input: { minWidth: 0, padding: '7px 9px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
} as const

export function MicButton({ controller }: { controller: VoiceController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const active = snapshot.state !== 'idle' && snapshot.state !== 'error'
  return <button
    type="button"
    aria-label={active ? '停止实时语音' : '开始实时语音'}
    aria-pressed={active}
    title={active ? '停止实时语音' : `开始实时语音（${snapshot.provider === 'qwen' ? '千问' : 'GPT'}）`}
    style={{ ...styles.button, ...(active ? styles.active : {}) }}
    onClick={() => { void controller.toggle() }}
  >
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z" /></svg>
  </button>
}

interface NativeInputProps {
  input: { readonly draft: string }
  inputActions: { setDraft(text: string): void; submit(): void }
}

export function VoiceStatus({ controller, input, inputActions }: { controller: VoiceController } & NativeInputProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => controller.bindDraft({
    getDraft: () => input.draft,
    setDraft: text => inputActions.setDraft(text),
    submit: () => inputActions.submit(),
  }), [controller, input.draft, inputActions])
  if (snapshot.state === 'idle') return null
  const labels: Record<string, string> = { connecting: '正在连接', listening: '正在聆听', speaking: '正在说话', working: 'Harness 正在执行', error: '语音不可用' }
  const continuePrefix = '继续任务：'
  if (snapshot.detail.startsWith(continuePrefix)) return <div role="status" data-voice-continue-task="" style={{ ...styles.dock, ...styles.continueDock }}>
    <span aria-hidden="true">↪</span>
    <span style={styles.continueTitle}>继续任务</span>
    <span>{snapshot.detail.slice(continuePrefix.length)}</span>
  </div>
  return <div role={snapshot.state === 'error' ? 'alert' : 'status'} style={styles.dock}>
    {snapshot.provider === 'qwen' ? '千问' : 'GPT'} · {labels[snapshot.state]}{snapshot.detail ? `：${snapshot.detail}` : ''}
  </div>
}

export function SettingsCard() {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, loadPrefs)
  const [open, setOpen] = useState(false)
  const [voiceprint, setVoiceprint] = useState<VoiceprintStatus>({ configured: false, enrolled: false })
  const [voiceprintMessage, setVoiceprintMessage] = useState('')
  useEffect(() => {
    if (!open || prefs.provider !== 'qwen') return
    void getVoiceprintStatus().then(setVoiceprint)
  }, [open, prefs.provider, prefs.voiceprintEnabled])
  return <li style={styles.card}>
    <button type="button" onClick={() => setOpen(!open)} style={{ width: '100%', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
      <strong>实时语音（千问 / GPT）</strong>
      <div style={{ opacity: .66, marginTop: 4 }}>独立 ASR → Harness 推理/插件 → 独立 TTS；不会由语音模型直接回答</div>
    </button>
    {open && <div>
      <Field label="服务商"><select style={styles.input} value={prefs.provider} onChange={e => updatePrefs({ provider: e.currentTarget.value === 'openai' ? 'openai' : 'qwen' })}><option value="qwen">国内：千问专用 ASR / TTS</option><option value="openai">全球：OpenAI GPT Realtime</option></select></Field>
      {prefs.provider === 'qwen' ? <>
        <Field label="Workspace ID"><input style={styles.input} value={prefs.qwenWorkspaceId} placeholder="阿里云百炼 Workspace ID" onChange={e => updatePrefs({ qwenWorkspaceId: e.currentTarget.value })} /></Field>
        <Field label="区域"><select style={styles.input} value={prefs.qwenRegion} onChange={e => updatePrefs({ qwenRegion: e.currentTarget.value === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing' })}><option value="cn-beijing">北京</option><option value="ap-southeast-1">新加坡</option></select></Field>
        <Field label="ASR 模型"><input style={styles.input} value={prefs.qwenAsrModel} onChange={e => updatePrefs({ qwenAsrModel: e.currentTarget.value })} /></Field>
        <Field label="TTS 模型"><input style={styles.input} value={prefs.qwenTtsModel} onChange={e => updatePrefs({ qwenTtsModel: e.currentTarget.value })} /></Field>
        <Field label="TTS 音色"><select style={styles.input} value={prefs.qwenTtsVoice} onChange={e => updatePrefs({ qwenTtsVoice: e.currentTarget.value })}><option value="Chelsie">Chelsie（软糯亲昵，最接近 Tina）</option><option value="Cherry">Cherry（清亮活泼）</option><option value="Serena">Serena（甜润亲切）</option><option value="Ethan">Ethan（清朗男声）</option></select></Field>
        <Field label="人声阈值"><input style={styles.input} type="number" min={-1} max={1} step={0.05} value={prefs.qwenVadThreshold} onChange={e => updatePrefs({ qwenVadThreshold: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="断句等待(ms)"><input style={styles.input} type="number" min={200} max={6000} step={100} value={prefs.qwenSilenceMs} onChange={e => updatePrefs({ qwenSilenceMs: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="语段合并等待(ms)"><input style={styles.input} type="number" min={100} max={5000} step={100} value={prefs.qwenMergeMs} onChange={e => updatePrefs({ qwenMergeMs: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="本人声纹软门控"><input type="checkbox" checked={prefs.voiceprintEnabled} onChange={e => updatePrefs({ voiceprintEnabled: e.currentTarget.checked })} /></Field>
        {prefs.voiceprintEnabled && <>
          <Field label="声纹通过分数"><input style={styles.input} type="number" min={0} max={100} step={1} value={prefs.voiceprintThreshold} onChange={e => updatePrefs({ voiceprintThreshold: e.currentTarget.valueAsNumber })} /></Field>
          <Field label="声纹状态"><div>
            <span>{!voiceprint.configured ? '缺少腾讯云凭据' : voiceprint.enrolled ? '已录入' : '待录入：重开语音后，说第一句至少 1 秒的人声'}</span>
            {voiceprint.enrolled && <button type="button" style={{ ...styles.input, marginLeft: 8, cursor: 'pointer' }} onClick={() => {
              setVoiceprintMessage('正在删除…')
              void deleteVoiceprint().then(result => {
                if (result.ok) { setVoiceprint({ ...voiceprint, enrolled: false }); setVoiceprintMessage('已删除') }
                else setVoiceprintMessage(result.error)
              })
            }}>删除声纹</button>}
            {voiceprintMessage && <div style={{ opacity: .66, fontSize: 12, marginTop: 4 }}>{voiceprintMessage}</div>}
          </div></Field>
        </>}
      </> : <>
        <Field label="模型"><input style={styles.input} value={prefs.openaiModel} onChange={e => updatePrefs({ openaiModel: e.currentTarget.value })} /></Field>
        <Field label="声音"><input style={styles.input} value={prefs.openaiVoice} onChange={e => updatePrefs({ openaiVoice: e.currentTarget.value })} /></Field>
      </>}
      <Field label="自然接场等待(ms)"><input style={styles.input} type="number" min={400} max={3000} step={100} value={prefs.floorDelayMs} onChange={e => updatePrefs({ floorDelayMs: e.currentTarget.valueAsNumber })} /></Field>
      <Field label="AI 灵活接场"><input type="checkbox" checked={prefs.floorComposerEnabled} onChange={e => updatePrefs({ floorComposerEnabled: e.currentTarget.checked })} /></Field>
      {prefs.floorComposerEnabled && <Field label="接场轻量模型"><input style={styles.input} value={prefs.provider === 'qwen' ? prefs.qwenFloorModel : prefs.openaiFloorModel} onChange={e => prefs.provider === 'qwen' ? updatePrefs({ qwenFloorModel: e.currentTarget.value }) : updatePrefs({ openaiFloorModel: e.currentTarget.value })} /></Field>}
      <Field label="播报风格"><textarea style={{ ...styles.input, minHeight: 84, resize: 'vertical' }} value={prefs.instructions} onChange={e => updatePrefs({ instructions: e.currentTarget.value })} /></Field>
      <p style={{ opacity: .66, fontSize: 12, lineHeight: 1.55 }}>密钥不会进入浏览器或插件配置：请由 Harness 凭据系统提供 {prefs.provider === 'qwen' ? 'DASHSCOPE_API_KEY' : 'OPENAI_API_KEY'}。空闲且输入框为空时，千问识别出的完整语句会自动交给 Harness；Harness 推理或播报期间的新语音才保留在原生输入框，等待发送或清空。声纹为可选的抗干扰软门控：开启后，首句只用于腾讯云录入，之后未通过或服务异常的语音只写入输入框而不自动发送；它不能替代身份认证或高风险操作授权，需要 Harness 凭据 TENCENT_SECRET_ID / TENCENT_SECRET_KEY。Tina 属于 Omni，专用 TTS 不支持；默认改用最接近其风格的 Chelsie。桌面壳当前禁用麦克风，点击话筒会在外部浏览器打开同一会话。</p>
    </div>}
  </li>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={styles.row}><span>{label}</span>{children}</label>
}
