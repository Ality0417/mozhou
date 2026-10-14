import { useRef, useState } from 'react'
import { novelApi } from '../../../api'
import type { VersionDiffInfo } from '../../../types'
import type { ChapterVersion, CtxSection, ResourceDetail } from '../types'
import type { VersionActions } from '../VersionHistoryPanel'
import { useChapterIdentity } from './useChapterIdentity'
import { useChapterMemory } from './useChapterMemory'

// v0.26.0（批次 B）：章节产物面板（待确认/记忆面/版本/上下文/资源详情）从页面拆出（AGENTS #38 先抽 hook）
// 回灌与角色状态确认保留在此，事实审阅与记忆面由 useChapterMemory 管理。
export function useChapterArtifacts(options: {
  novelId: number
  selectedChapter: number | null
  notify: (msg: string) => void
  withBusy: (key: string, fn: () => Promise<void> | void) => Promise<void>
  confirmFn: (o: { title: string; message: string; confirmText?: string; danger?: boolean; action: () => void }) => void
  invalidate: () => Promise<void>
  setContent: (v: string) => void
  savedContentRef: React.RefObject<string>
  dirtyRef: React.RefObject<boolean>
  readContent: () => string
  saveContent: () => Promise<void>
  onActionError: (msg: string | null) => void
}): ReturnType<typeof useChapterMemory> & {
  versions: ChapterVersion[] | null
  showVersions: boolean
  setShowVersions: (v: boolean) => void
  versionDiff: VersionDiffInfo | null
  setVersionDiff: (d: VersionDiffInfo | null) => void
  loadVersions: () => Promise<void>
  snapshotNow: () => Promise<void>
  versionActions: VersionActions
  ctxSections: CtxSection[] | null
  ctxToggles: Record<string, boolean> | null
  setCtxToggles: React.Dispatch<React.SetStateAction<Record<string, boolean> | null>>
  loadContextPreview: () => Promise<void>
  closeContextPanel: () => void
  resourceDetail: ResourceDetail | null
  setResourceDetail: (d: ResourceDetail | null) => void
  closeAllPanels: () => void
  backfill: () => Promise<void>
  backfillResult: Record<string, unknown> | null
  setBackfillResult: (r: Record<string, unknown> | null) => void
  confirmStates: () => Promise<void>
} {
  const { novelId, selectedChapter, notify, withBusy, confirmFn, invalidate, setContent, savedContentRef, dirtyRef, onActionError } = options
  const id = novelId
  const identity = useChapterIdentity(novelId, selectedChapter)
  const latest = useRef(options)
  latest.current = options
  const requests = useRef<Record<string, number>>({})
  const begin = (key: string): (() => boolean) => {
    const token = identity.capture()
    const sequence = (requests.current[key] ?? 0) + 1
    requests.current[key] = sequence
    return () => identity.isActive(token) && requests.current[key] === sequence
  }
  const restoreBusy = useRef(false)

  const memoryReview = useChapterMemory(options)

  // A3：版本历史
  const [versions, setVersions] = useState<ChapterVersion[] | null>(null)
  const [showVersions, setShowVersions] = useState(false)
  const [versionDiff, setVersionDiff] = useState<VersionDiffInfo | null>(null)
  const loadVersions = async (): Promise<void> => {
    if (!selectedChapter) return
    const valid = begin('versions')
    try {
      const r = await novelApi.versions(id, selectedChapter)
      if (!valid()) return
      setVersions(r.versions)
      setShowVersions(true)
      setVersionDiff(null)
    } catch (err) {
      onActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const snapshotNow = async (): Promise<void> => {
    if (!selectedChapter) return
    const active = begin('snapshot')
    try {
      await options.saveContent()
      if (!active()) return
      await novelApi.createVersion(id, selectedChapter, '手动快照')
      if (!active()) return
      notify('已创建版本快照')
      await loadVersions()
    } catch (err) {
      onActionError(err instanceof Error ? err.message : String(err))
    }
  }

  // B1：加载上下文预览
  const [ctxSections, setCtxSections] = useState<CtxSection[] | null>(null)
  const [ctxToggles, setCtxToggles] = useState<Record<string, boolean> | null>(null)
  const loadContextPreview = async (): Promise<void> => {
    if (!selectedChapter) return
    const valid = begin('context')
    try {
      const r = await novelApi.contextPreview(id, selectedChapter)
      if (!valid()) return
      setCtxSections(r.sections)
      setCtxToggles((prev) => {
        if (prev) return prev
        const init: Record<string, boolean> = {}
        for (const s of r.sections) init[s.key] = true
        return init
      })
    } catch (err) {
      onActionError(err instanceof Error ? err.message : String(err))
    }
  }
  const closeContextPanel = (): void => {
    setCtxSections(null)
    setCtxToggles(null)
  }

  // D1：资源详情浮层（左栏资源树与版本「查看」共用）
  const [resourceDetail, setResourceDetail] = useState<ResourceDetail | null>(null)

  // A3：版本历史动作（数据操作在此，呈现交给 VersionHistoryPanel）
  const versionActions: VersionActions = {
    view: (v) => {
      if (!selectedChapter) return
      const valid = begin('versionView')
      void withBusy(`vview-${v.id}`, async () => {
        try {
          const r = await novelApi.chapterVersionDetail(id, selectedChapter, v.id)
          if (!valid()) return
          setResourceDetail({ title: `版本 #${v.id}（${v.note} · ${v.createdAt}）`, body: r.version.content })
        } catch (err) {
          onActionError(err instanceof Error ? err.message : String(err))
        }
      })
    },
    restore: (v) => {
      if (!selectedChapter) return
      const active = begin('restore')
      confirmFn({
        title: '恢复版本',
        message: `恢复为版本 #${v.id}？当前内容会先存入新版本，然后被替换。`,
        confirmText: '恢复',
        danger: true,
        action: () =>
          void withBusy(`vrestore-${v.id}`, async () => {
            if (!active() || restoreBusy.current) return
            restoreBusy.current = true
            try {
              await options.saveContent()
              if (!active()) return
              const original = latest.current.readContent()
              const r = await novelApi.chapterVersionRestore(id, selectedChapter, v.id, {
                expectedContent: original, operationId: crypto.randomUUID()
              })
              if (!active()) { await invalidate(); return }
              const currentContent = r.currentContent ?? r.content
              savedContentRef.current = currentContent
              if (latest.current.readContent() !== original || currentContent !== r.content) {
                dirtyRef.current = latest.current.readContent() !== currentContent
                notify('版本已恢复，当前新增输入已保留，请核对后保存')
                await invalidate()
                return
              }
              setContent(currentContent)
              dirtyRef.current = false
              notify(`已恢复版本 #${v.id}（${r.wordCount} 字），原内容已存为新版本`)
              await invalidate()
            } catch (err) {
              if (active()) onActionError(err instanceof Error ? err.message : String(err))
            } finally { restoreBusy.current = false }
          })
      })
    },
    diff: (v) => {
      if (!selectedChapter) return
      const valid = begin('diff')
      void withBusy(`vdiff-${v.id}`, async () => {
        try {
          const d = await novelApi.chapterVersionDiff(id, selectedChapter, v.id)
          if (!valid()) return
          setVersionDiff(d)
        } catch (err) {
          onActionError(err instanceof Error ? err.message : String(err))
        }
      })
    }
  }

  // P9 D16：Esc 一键关闭浮层面板
  const closeAllPanels = (): void => {
    setShowVersions(false)
    memoryReview.setShowPending(false)
    memoryReview.setShowMemory(false)
    setCtxSections(null)
    setResourceDetail(null)
  }

  // 角色状态入账与事实确认相互独立，不能顺带确认事实。
  const [backfillResult, setBackfillResult] = useState<Record<string, unknown> | null>(null)
  const backfill = async (): Promise<void> => {
    if (!selectedChapter) return
    const valid = begin('backfill')
    const original = options.readContent()
    onActionError(null)
    notify('回灌提取中…')
    try {
      const r = await novelApi.backfill(id, selectedChapter)
      if (!valid() || latest.current.readContent() !== original) return
      setBackfillResult(r)
      notify('回灌完成：角色状态待入账，新事实请逐条确认；伏笔已记录')
    } catch (err) {
      onActionError(err instanceof Error ? err.message : String(err))
    }
  }
  const confirmStates = async (): Promise<void> => {
    if (!backfillResult || !Array.isArray(backfillResult.characterStates)) return
    await withBusy('confirm', async () => {
      await novelApi.confirmState(id, backfillResult.characterStates as Array<{ name: string; state: string }>)
      setBackfillResult(null)
      notify('角色状态已确认入账')
    })
  }

  return {
    ...memoryReview,
    versions,
    showVersions,
    setShowVersions,
    versionDiff,
    setVersionDiff,
    loadVersions,
    snapshotNow,
    versionActions,
    ctxSections,
    ctxToggles,
    setCtxToggles,
    loadContextPreview,
    closeContextPanel,
    resourceDetail,
    setResourceDetail,
    closeAllPanels,
    backfill,
    backfillResult,
    setBackfillResult,
    confirmStates
  }
}
