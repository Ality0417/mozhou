// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EditorState } from '@codemirror/state'
import { ExternalChange } from '@uiw/react-codemirror'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, novelApi } from '../client/src/api'
import { ProjectWritingPanel } from '../client/src/workspace/ProjectWritingPanel'
import { Onboarding } from '../client/src/pages/Onboarding'
import { aiWrite, useEditorSession, type EditorSessionDeps } from '../client/src/pages/chapter/hooks/useEditorSession'
import { defaultWritingProfile } from '../shared/src/writingProfile'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { Server } from 'node:http'
import JSZip from 'jszip'
import { applyMigrations } from '../server/src/db/migrate'
import { seedIfEmpty } from '../server/src/db/seed'
import { createExportRouter } from '../server/src/routes/export'
import { apiErrorMiddleware } from '../server/src/services/apiError'

vi.mock('../client/src/api', () => ({ apiFetch: vi.fn(), novelApi: { chapterPatch: vi.fn(), createVersion: vi.fn(), chapterDetail: vi.fn() } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function response(language: 'zh-CN' | 'en' = 'zh-CN') { return { profile: defaultWritingProfile(language), inherited: false } }
function provider(client: QueryClient, children: React.ReactNode) { return <QueryClientProvider client={client}>{children}</QueryClientProvider> }
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) }

beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)

describe('independent profile interaction QA', () => {
  it('deduplicates same-tick submit and freezes the submitted draft while saving', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    vi.mocked(apiFetch).mockImplementation(async (_url, options) => options?.method === 'PUT' ? pending.promise : response())
    const dirty = vi.fn()
    render(provider(client(), <ProjectWritingPanel novelId={1} onDirtyChange={dirty} />))
    const language = await screen.findByLabelText('创作语言')
    fireEvent.change(language, { target: { value: 'en' } })
    fireEvent.change(screen.getByLabelText('目标市场'), { target: { value: 'Original English fiction' } })
    const form = screen.getByRole('button', { name: '保存本书档案' }).closest('form')!
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'PUT')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ language: 'en', market: 'Original English fiction' })
    expect((form.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    fireEvent.change(language, { target: { value: 'zh-CN' } })
    expect((language as HTMLSelectElement).value).toBe('en')
    await act(async () => { pending.resolve(response('en')); await pending.promise })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(dirty).toHaveBeenLastCalledWith(false)
  })

  it('a late save from another book cannot clear current edits or replace its fields', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    vi.mocked(apiFetch).mockImplementation(async (_url, options) => options?.method === 'PUT' ? pending.promise : response())
    const queryClient = client(), dirty = vi.fn()
    const view = render(provider(queryClient, <ProjectWritingPanel novelId={1} onDirtyChange={dirty} />))
    fireEvent.change(await screen.findByLabelText('目标市场'), { target: { value: 'Book A market' } })
    fireEvent.click(screen.getByRole('button', { name: '保存本书档案' }))
    view.rerender(provider(queryClient, <ProjectWritingPanel novelId={2} onDirtyChange={dirty} />))
    fireEvent.change(await screen.findByLabelText('目标市场'), { target: { value: 'Book B unsaved market' } })
    dirty.mockClear()
    await act(async () => { pending.resolve(response('en')); await pending.promise })
    expect((screen.getByLabelText('目标市场') as HTMLInputElement).value).toBe('Book B unsaved market')
    expect((screen.getByLabelText('创作语言') as HTMLSelectElement).value).toBe('zh-CN')
    expect(dirty).not.toHaveBeenCalledWith(false)
    expect(queryClient.getQueryData(['writing-profile', 1])).toEqual(response('en'))
  })

  it('failed saves preserve the author draft and permit an explicit retry', async () => {
    let attempts = 0
    vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
      if (options?.method !== 'PUT') return response()
      if (++attempts === 1) throw Error('模拟保存失败')
      return response('en')
    })
    render(provider(client(), <ProjectWritingPanel novelId={1} />))
    fireEvent.change(await screen.findByLabelText('创作语言'), { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: '保存本书档案' }))
    expect(await screen.findByText('模拟保存失败')).toBeTruthy()
    expect((screen.getByLabelText('创作语言') as HTMLSelectElement).value).toBe('en')
    fireEvent.click(screen.getByRole('button', { name: '保存本书档案' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(attempts).toBe(2)
  })

  it('local onboarding does not save credentials, test a provider or call a model', () => {
    const local = vi.fn(), done = vi.fn()
    render(<Onboarding onDone={done} onLocalMode={local} />)
    fireEvent.click(screen.getByRole('button', { name: '先本地体验（无需 API Key）' }))
    expect(local).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.getByText(/本地体验不会模拟或冒充真实生成/)).toBeTruthy()
  })
})

function editorDeps(language: 'zh-CN' | 'en' = 'zh-CN'): EditorSessionDeps {
  return {
    novelId: 1, writingLanguage: language, selectedChapter: 1,
    editorRef: { current: null }, streamingRef: { current: false }, contentLoadingRef: { current: false },
    loadedChapterRef: { current: 1 }, savedContentRef: { current: '' }, dirtyRef: { current: false },
    invalidate: vi.fn().mockResolvedValue(undefined), toast: vi.fn(), notify: vi.fn(), onActionError: vi.fn()
  }
}
function updateFor(transaction: ReturnType<EditorState['update']>) {
  return { docChanged: transaction.docChanged, transactions: [transaction], changes: transaction.changes, startState: transaction.startState, state: transaction.state }
}

describe('independent real CodeMirror transaction integrity', () => {
  it('counts Chinese inserts and replacements without crashing, then saves exactly one human delta', async () => {
    const deps = editorDeps(), { result } = renderHook(() => useEditorSession(deps))
    vi.mocked(novelApi.chapterPatch).mockImplementation(async (_novel, _chapter, payload) => ({ ok: true, replayed: false, currentContent: String(payload.content) }))
    let state = EditorState.create({ doc: '' })
    for (const change of [{ from: 0, insert: '春雨落在石桥上。' }, { from: 0, to: 2, insert: '细雨' }]) {
      const transaction = state.update({ changes: change })
      expect(Array.isArray((transaction.changes as unknown as { inserted: unknown }).inserted)).toBe(true)
      act(() => { result.current.trackHumanWords(updateFor(transaction)); result.current.setContent(transaction.state.doc.toString()) })
      state = transaction.state
    }
    expect(result.current.content).toBe('细雨落在石桥上。')
    expect(result.current.hanCount).toBe(7)
    expect(result.current.humanDeltaRef.current).toBe(9)
    await act(async () => { await result.current.saveContent() })
    expect(novelApi.chapterPatch).toHaveBeenCalledWith(1, 1, expect.objectContaining({ content: '细雨落在石桥上。', humanWordsDelta: 9 }))
    expect(result.current.humanDeltaRef.current).toBe(0)
    expect(result.current.content).toBe('细雨落在石桥上。')
  })

  it.each(['zh-CN', 'en'] as const)('does not credit external chapter loading or AI text as human input in %s', language => {
    const { result } = renderHook(() => useEditorSession(editorDeps(language)))
    const state = EditorState.create({ doc: '' })
    const text = language === 'en' ? 'A complete chapter loaded from storage.' : '从服务器加载的完整章节。'
    const external = state.update({ changes: { from: 0, insert: text }, annotations: ExternalChange.of(true) })
    act(() => { result.current.trackHumanWords(updateFor(external)) })
    expect(result.current.humanDeltaRef.current).toBe(0)
    const generated = state.update({ changes: { from: 0, insert: text }, annotations: aiWrite.of(true) })
    act(() => { result.current.trackHumanWords(updateFor(generated)) })
    expect(result.current.humanDeltaRef.current).toBe(0)
  })

  it('counts an English word once across character-by-character typing', () => {
    const { result } = renderHook(() => useEditorSession(editorDeps('en')))
    let state = EditorState.create({ doc: '' })
    for (const character of 'Hello world') {
      const transaction = state.update({ changes: { from: state.doc.length, insert: character } })
      act(() => { result.current.trackHumanWords(updateFor(transaction)) })
      state = transaction.state
    }
    expect(result.current.humanDeltaRef.current).toBe(2)
  })
})

describe('independent long manuscript export integrity', () => {
  it.each(['zh-CN', 'en'] as const)('keeps a complete >8k-character %s chapter and excludes private notes in all four formats', async language => {
    const db = new DatabaseSync(':memory:', { timeout: 5000, enableForeignKeyConstraints: true })
    applyMigrations(db)
    seedIfEmpty(db)
    const profile = defaultWritingProfile(language)
    const sentence = language === 'en' ? 'The lantern crossed the old harbor without losing its light. ' : '渡船穿过旧港，守灯人仍握着完整的航海图。'
    const content = sentence.repeat(700) + (language === 'en' ? 'UNIQUE ENDING: Mara found the original map & kept <every page>.' : '唯一结尾：林禾找到了原图，保留了 <全部页面> & 最后一行。')
    const privateNote = 'PRIVATE-PLANNING-NOTE-DO-NOT-EXPORT'
    const novelId = Number(db.prepare('INSERT INTO novel(title,inspiration,writing_profile_json) VALUES (?,?,?)').run('Independent QA manuscript', privateNote, JSON.stringify(profile)).lastInsertRowid)
    db.prepare("INSERT INTO chapter(novel_id,title,content,status) VALUES (?,'The complete chapter',?,'written')").run(novelId, content)
    const app = express()
    app.use('/api/novels', createExportRouter(db))
    app.use(apiErrorMiddleware)
    const server: Server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)) })
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/novels/${novelId}`
    try {
      expect(content.length).toBeGreaterThan(8000)
      const preview = await (await fetch(`${url}/export-preview`)).json()
      expect(preview.chapters[0].content).toBe(content)
      expect(preview.inspiration).toBe('')
      for (const format of ['txt', 'md', 'docx', 'epub']) {
        const result = await fetch(`${url}/export?format=${format}`)
        expect(result.status).toBe(200)
        const bytes = Buffer.from(await result.arrayBuffer())
        if (format === 'txt' || format === 'md') {
          expect(bytes.toString('utf8')).toContain(content)
          expect(bytes.toString('utf8')).not.toContain(privateNote)
          continue
        }
        const zip = await JSZip.loadAsync(bytes)
        const entries = Object.values(zip.files).filter(file => !file.dir && /\.(xml|xhtml|html|opf)$/.test(file.name))
        const documents = await Promise.all(entries.map(file => file.async('string')))
        expect(documents.join('\n')).not.toContain(privateNote)
        const decoded = documents.map(xml => new DOMParser().parseFromString(xml, 'text/xml').documentElement.textContent ?? '')
        expect(decoded.some(text => text.includes(content))).toBe(true)
      }
      expect(db.prepare('SELECT content FROM chapter WHERE novel_id=?').get(novelId)?.content).toBe(content)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      db.close()
    }
  })
})
