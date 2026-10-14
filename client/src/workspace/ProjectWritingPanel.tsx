import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api'
import { ErrorMsg } from '../components/ErrorMsg'
import { writingProfileSchema, LANGUAGE_LABELS, PROFILE_LABELS, type WritingProfile } from '../../../shared/src/writingProfile'

interface ProfileResponse { profile: WritingProfile; inherited: boolean }
export function ProjectWritingPanel({ novelId, onDirtyChange }: { novelId: number; onDirtyChange?: (dirty: boolean) => void }): React.JSX.Element {
  const query = useQuery({ queryKey: ['writing-profile', novelId], queryFn: () => apiFetch(`/novels/${novelId}/writing-profile`) as Promise<ProfileResponse> })
  return <section className="panel" aria-label="项目语言与投稿档案">
    <h2>项目语言与投稿档案</h2>
    <p className="muted t-small">先按中文/英文创作与通用格式打磨。这里不是任何平台的官方规则，也不会自动上传或发布。</p>
    {query.isError && <ErrorMsg error={`档案加载失败：${String(query.error)}`} onRetry={() => void query.refetch()} />}
    {query.isLoading && <p className="muted">正在读取项目档案…</p>}
    {query.data && <ProfileEditor key={novelId} novelId={novelId} initial={query.data} onDirtyChange={onDirtyChange} />}
  </section>
}
function ProfileEditor({ novelId, initial, onDirtyChange }: { novelId: number; initial: ProfileResponse; onDirtyChange?: (dirty: boolean) => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(initial.profile)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const busy = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const change = (patch: Partial<WritingProfile>): void => {
    if (busy.current) return
    setDraft(value => ({ ...value, ...patch })); setSaved(false); onDirtyChange?.(true)
  }
  const save = async (): Promise<void> => {
    if (busy.current) return
    const parsed = writingProfileSchema.safeParse(draft)
    if (!parsed.success) { setError('请填写有效档案：章节目标为 300–12000，市场最多 80 字，补充要求最多 1200 字。'); return }
    busy.current = true; setSaving(true); setError(null)
    try {
      const result = await apiFetch(`/novels/${novelId}/writing-profile`, { method: 'PUT', body: JSON.stringify(parsed.data) }) as ProfileResponse
      queryClient.setQueryData(['writing-profile', novelId], result)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['chapters', novelId] }), queryClient.invalidateQueries({ queryKey: ['novel-stats', novelId] })])
      if (!alive.current) return
      setSaved(true); onDirtyChange?.(false)
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; if (alive.current) setSaving(false) }
  }
  return <form onSubmit={event => { event.preventDefault(); void save() }}>
    <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <label>创作语言<select aria-label="创作语言" value={draft.language} onChange={event => change({ language: event.target.value as WritingProfile['language'] })} style={{ display: 'block', width: '100%' }}>{Object.entries(LANGUAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>通用编辑档案<select aria-label="通用编辑档案" value={draft.preset} onChange={event => change({ preset: event.target.value as WritingProfile['preset'] })} style={{ display: 'block', width: '100%' }}>{Object.entries(PROFILE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>章节目标（{draft.language === 'en' ? '英文词' : '汉字'}）<input aria-label="章节目标" type="number" min={300} max={12000} value={draft.targetChapterLength} onChange={event => change({ targetChapterLength: Number(event.target.value) })} style={{ width: '100%' }} /></label>
        <label>目标国家/地区或读者（可选）<input aria-label="目标市场" maxLength={80} value={draft.market} onChange={event => change({ market: event.target.value })} placeholder="例如：英语读者 / 北美" style={{ width: '100%' }} /></label>
      </div>
      <label style={{ display: 'block', marginTop: 12 }}>补充创作要求<textarea aria-label="补充创作要求" maxLength={1200} value={draft.notes} onChange={event => change({ notes: event.target.value })} placeholder="人物命名、文化语境、节奏等。不要填写密码或私人资料。" style={{ width: '100%', minHeight: 70 }} /></label>
      <div className="row flex-wrap" style={{ gap: 12, marginTop: 12 }}>
        <label>导出章节标题 <select aria-label="导出章节标题" value={draft.export.heading} onChange={event => change({ export: { ...draft.export, heading: event.target.value as 'original' | 'numbered' } })}><option value="original">保留原标题</option><option value="numbered">增加语言对应的序号</option></select></label>
        <label>TXT 换行 <select aria-label="TXT 换行" value={draft.export.lineEnding} onChange={event => change({ export: { ...draft.export, lineEnding: event.target.value as 'lf' | 'crlf' } })}><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
        <label><input type="checkbox" checked={draft.export.utf8Bom} onChange={event => change({ export: { ...draft.export, utf8Bom: event.target.checked } })} /> TXT UTF-8 BOM</label>
        <label><input type="checkbox" checked={draft.export.includeInspiration} onChange={event => change({ export: { ...draft.export, includeInspiration: event.target.checked } })} /> 导出包含灵感原文</label>
      </div>
      <p className="muted t-small">语言设置作用于后续规划、正文、审核与修复，不会自动翻译已有作品。单章字/词统计按本书语言计算；既有 AI/人工累计统计不追溯换算。投稿前仍需核对目标平台当前 AI 披露、版权、内容及格式要求。</p>
      <div className="row" style={{ gap: 12 }}><button type="submit" className="primary">{saving ? '保存中…' : '保存本书档案'}</button><span role="status" className="muted t-small">{saved ? '已保存，后续创作和导出使用此档案' : initial.inherited ? '尚未保存独立档案，当前沿用应用语言' : '修改后请保存'}</span></div>
    </fieldset>
    {error && <ErrorMsg error={error} />}
  </form>
}
