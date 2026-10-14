import { useEffect, useRef, useState } from 'react'
import { novelApi } from '../../../api'
import type { FactReviewInput, PendingFact } from '../../../types'
import type { MemoryData, PendingData } from '../types'
import { useChapterIdentity } from './useChapterIdentity'

export function useChapterMemory(options: {
  novelId: number
  selectedChapter: number | null
  notify: (message: string) => void
  onActionError: (message: string | null) => void
  confirmFn: (input: { title: string; message: string; confirmText?: string; danger?: boolean; action: () => void }) => void
}) {
  const { novelId, selectedChapter, notify, onActionError, confirmFn } = options
  const identity = useChapterIdentity(novelId, selectedChapter)
  const requests = useRef({ pending: 0, memory: 0 })
  const locks = useRef({ pending: false, memory: false, patch: false, fact: false })
  const [pending, setPending] = useState<PendingData | null>(null)
  const [showPending, setShowPending] = useState(false)
  const [pendingBusy, setPendingBusy] = useState(false)
  const [memory, setMemory] = useState<MemoryData | null>(null)
  const [showMemory, setShowMemory] = useState(false)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryPatchBusy, setMemoryPatchBusy] = useState(false)
  const [factReviewBusy, setFactReviewBusy] = useState(false)

  useEffect(() => {
    setPending(null)
    setMemory(null)
    setShowPending(false)
    setShowMemory(false)
  }, [novelId, selectedChapter])

  const loadPending = async (): Promise<void> => {
    if (locks.current.pending) return
    locks.current.pending = true
    setPendingBusy(true)
    const token = identity.capture()
    const sequence = ++requests.current.pending
    try {
      const result = await novelApi.pending(novelId)
      if (!identity.isActive(token) || sequence !== requests.current.pending) return
      setPending(result)
      setShowPending(true)
    } catch (err) {
      if (identity.isActive(token)) onActionError(err instanceof Error ? err.message : String(err))
    } finally {
      locks.current.pending = false
      setPendingBusy(false)
    }
  }

  const loadMemory = async (): Promise<void> => {
    if (locks.current.memory) return
    locks.current.memory = true
    setMemoryBusy(true)
    const token = identity.capture()
    const sequence = ++requests.current.memory
    try {
      const result = await novelApi.memory(novelId)
      if (!identity.isActive(token) || sequence !== requests.current.memory) return
      setMemory(result)
      setShowMemory(true)
    } catch (err) {
      if (identity.isActive(token)) onActionError(err instanceof Error ? err.message : String(err))
    } finally {
      locks.current.memory = false
      setMemoryBusy(false)
    }
  }

  const patchMemory = async (operation: () => Promise<unknown>): Promise<void> => {
    if (locks.current.patch) return
    locks.current.patch = true
    setMemoryPatchBusy(true)
    const token = identity.capture()
    try {
      await operation()
      if (identity.isActive(token)) await loadMemory()
    } catch (err) {
      if (identity.isActive(token)) onActionError(err instanceof Error ? err.message : String(err))
    } finally {
      locks.current.patch = false
      setMemoryPatchBusy(false)
    }
  }
  const patchCharState = (name: string, state: string, remove: boolean): Promise<void> =>
    patchMemory(() => novelApi.memoryCharacter(novelId, { name, state, remove }))
  const patchFactionState = (name: string, state: string): Promise<void> =>
    patchMemory(() => novelApi.memoryFaction(novelId, { name, state }))

  const reviewPendingFact = async (fact: PendingFact, action: FactReviewInput['action']): Promise<void> => {
    const token = identity.capture()
    const apply = async (): Promise<void> => {
      if (!identity.isActive(token) || locks.current.fact) return
      locks.current.fact = true
      setFactReviewBusy(true)
      onActionError(null)
      try {
        await novelApi.reviewFact(novelId, fact.id, { action, expectedContent: fact.content })
        if (!identity.isActive(token)) return
        ++requests.current.pending
        ++requests.current.memory
        setPending((current) => current && ({ ...current, pendingFacts: current.pendingFacts.filter((item) => item.id !== fact.id) }))
        setMemory((current) => current && ({ ...current, pendingFacts: current.pendingFacts.filter((item) => item.id !== fact.id) }))
        notify(action === 'confirm' ? '事实已确认，将作为后续写作约束' : '已移除这条待确认事实')
      } catch (err) {
        if (identity.isActive(token)) onActionError(err instanceof Error ? err.message : String(err))
      } finally {
        locks.current.fact = false
        setFactReviewBusy(false)
      }
    }
    if (action === 'reject') {
      confirmFn({
        title: '拒绝待确认事实',
        message: `移除「${fact.content}」？这不会改动章节正文或已确认事实。`,
        confirmText: '拒绝并移除', danger: true, action: () => { void apply() }
      })
    } else {
      await apply()
    }
  }

  return {
    pending, showPending, setShowPending, pendingBusy, loadPending,
    memory, showMemory, setShowMemory, memoryBusy, memoryPatchBusy, loadMemory,
    patchCharState, patchFactionState, factReviewBusy, reviewPendingFact
  }
}
