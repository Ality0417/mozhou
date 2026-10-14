// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { novelApi } from '../client/src/api'
import { useChapterMemory } from '../client/src/pages/chapter/hooks/useChapterMemory'
import { PendingPanel } from '../client/src/pages/chapter/PendingPanel'
import { MemoryPanel } from '../client/src/pages/chapter/ReviewPanel'

vi.mock('../client/src/api', () => ({ novelApi: {
  pending: vi.fn(), memory: vi.fn(), reviewFact: vi.fn(), memoryCharacter: vi.fn(), memoryFaction: vi.fn()
} }))
const fact = { id: 7, content: '需要作者核对', chapterId: 3, chapterTitle: '旧城的秘密' }
const pending = { pendingFacts: [fact], pendingCharacters: [] }
const memory = { characters: [], factions: [], pendingFacts: [fact] }
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(novelApi.pending).mockResolvedValue(pending)
  vi.mocked(novelApi.memory).mockResolvedValue(memory)
  vi.mocked(novelApi.reviewFact).mockResolvedValue({ ok: true, changed: true })
})
afterEach(cleanup)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { resolve, promise }
}
function options() {
  return { novelId: 1, selectedChapter: 3, notify: vi.fn(), onActionError: vi.fn(), confirmFn: vi.fn() }
}

describe('事实审阅控件', () => {
  it('待确认区显示来源与未入账说明，确认和拒绝传递所见原文', () => {
    const review = vi.fn()
    render(<PendingPanel pending={pending} onClose={vi.fn()} onReviewFact={review} />)
    expect(screen.getByText('来源：旧城的秘密')).toBeTruthy()
    expect(screen.getByText(/未确认内容不会作为已确认事实/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认事实入账' }))
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(review.mock.calls).toEqual([[fact, 'confirm'], [fact, 'reject']])
  })

  it('记忆面复用同一审阅入口，忙碌时两个按钮均禁用', () => {
    const review = vi.fn()
    render(<MemoryPanel memory={memory} patchBusy={false} factBusy onReviewFact={review}
      onPatchCharState={vi.fn()} onPatchFactionState={vi.fn()} onClose={vi.fn()} />)
    for (const name of ['确认事实入账', '拒绝']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(review).not.toHaveBeenCalled()
  })
})

describe('事实审阅异步归属', () => {
  it('同一 tick 多次确认只发一次请求，成功后同时更新两个面板', async () => {
    const response = deferred<{ ok: boolean; changed: boolean }>()
    vi.mocked(novelApi.reviewFact).mockReturnValue(response.promise)
    const { result } = renderHook(() => useChapterMemory(options()))
    await act(async () => { await result.current.loadPending(); await result.current.loadMemory() })
    let first!: Promise<void>
    await act(async () => {
      first = result.current.reviewPendingFact(fact, 'confirm')
      await result.current.reviewPendingFact(fact, 'confirm')
    })
    expect(novelApi.reviewFact).toHaveBeenCalledOnce()
    expect(novelApi.reviewFact).toHaveBeenCalledWith(1, 7, { action: 'confirm', expectedContent: fact.content })
    expect(result.current.factReviewBusy).toBe(true)
    await act(async () => { response.resolve({ ok: true, changed: true }); await first })
    expect(result.current.pending?.pendingFacts).toEqual([])
    expect(result.current.memory?.pendingFacts).toEqual([])
    expect(result.current.factReviewBusy).toBe(false)
  })

  it('确认失败不隐藏事实且解除锁，允许作者重试', async () => {
    const props = options()
    vi.mocked(novelApi.reviewFact).mockRejectedValueOnce(Error('事实已变更')).mockResolvedValue({ ok: true, changed: true })
    const { result } = renderHook(() => useChapterMemory(props))
    await act(async () => { await result.current.loadPending(); await result.current.reviewPendingFact(fact, 'confirm') })
    expect(result.current.pending?.pendingFacts).toEqual([fact])
    expect(result.current.factReviewBusy).toBe(false)
    expect(props.onActionError).toHaveBeenCalledWith('事实已变更')
    await act(async () => { await result.current.reviewPendingFact(fact, 'confirm') })
    expect(result.current.pending?.pendingFacts).toEqual([])
    expect(novelApi.reviewFact).toHaveBeenCalledTimes(2)
  })

  it('拒绝先要求确认，确认期间切书后不会执行旧书操作', async () => {
    const props = options()
    const { result, rerender } = renderHook(useChapterMemory, { initialProps: props })
    await act(async () => { await result.current.reviewPendingFact(fact, 'reject') })
    expect(novelApi.reviewFact).not.toHaveBeenCalled()
    const confirmation = props.confirmFn.mock.calls[0][0] as { action: () => void }
    rerender({ ...props, novelId: 2 })
    await act(async () => { confirmation.action() })
    expect(novelApi.reviewFact).not.toHaveBeenCalled()
  })

  it('拒绝确认通过后仅发送这条事实，不改动角色或势力', async () => {
    const props = options()
    const { result } = renderHook(() => useChapterMemory(props))
    await act(async () => { await result.current.loadPending(); await result.current.reviewPendingFact(fact, 'reject') })
    await act(async () => { props.confirmFn.mock.calls[0][0].action() })
    expect(novelApi.reviewFact).toHaveBeenCalledWith(1, 7, { action: 'reject', expectedContent: fact.content })
    expect(result.current.pending?.pendingFacts).toEqual([])
    expect(novelApi.memoryCharacter).not.toHaveBeenCalled()
    expect(novelApi.memoryFaction).not.toHaveBeenCalled()
  })

  it('确认后到达的旧查询不能把事实重新放回待确认区', async () => {
    const response = deferred<typeof pending>()
    const { result } = renderHook(() => useChapterMemory(options()))
    await act(async () => { await result.current.loadPending() })
    vi.mocked(novelApi.pending).mockReturnValue(response.promise)
    let query!: Promise<void>
    await act(async () => { query = result.current.loadPending(); await result.current.reviewPendingFact(fact, 'confirm') })
    await act(async () => { response.resolve(pending); await query })
    expect(result.current.pending?.pendingFacts).toEqual([])
  })

  it('书籍 A→B→A 导航会失效旧查询，不显示旧面板', async () => {
    const response = deferred<typeof pending>()
    vi.mocked(novelApi.pending).mockReturnValue(response.promise)
    const props = options()
    const { result, rerender } = renderHook(useChapterMemory, { initialProps: props })
    let query!: Promise<void>
    await act(async () => { query = result.current.loadPending() })
    rerender({ ...props, novelId: 2 })
    rerender(props)
    await act(async () => { response.resolve(pending); await query })
    expect(result.current.pending).toBeNull()
    expect(result.current.showPending).toBe(false)
  })
})
