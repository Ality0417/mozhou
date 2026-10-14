import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { Server } from 'node:http'
import { applyMigrations } from '../server/src/db/migrate'
import { seedIfEmpty } from '../server/src/db/seed'
import { registerChapterBackfillRoutes } from '../server/src/routes/chapters/backfill'
import { apiErrorMiddleware } from '../server/src/services/apiError'
import { listPendingFacts, reviewFact, writePendingFacts } from '../server/src/services/facts'
import { buildChapterWriteContext } from '../server/src/services/context/dynamic'
import { callLlmJson } from '../server/src/services/jsonSafe'

vi.mock('../server/src/services/jsonSafe', () => ({ callLlmJson: vi.fn() }))
vi.mock('../server/src/services/smartContext', async (original) => ({
  ...await original<typeof import('../server/src/services/smartContext')>(),
  updateSmartContext: vi.fn().mockResolvedValue(null)
}))

let db: DatabaseSync
let novelId: number
let chapterId: number
let nextChapterId: number
beforeEach(() => {
  vi.clearAllMocks()
  db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true, timeout: 5000 })
  applyMigrations(db)
  seedIfEmpty(db)
  novelId = Number(db.prepare("INSERT INTO novel (title, inspiration) VALUES ('测试书', '测试')").run().lastInsertRowid)
  chapterId = Number(db.prepare("INSERT INTO chapter (novel_id, title, content) VALUES (?, '旧城', '章节正文')").run(novelId).lastInsertRowid)
  nextChapterId = Number(db.prepare("INSERT INTO chapter (novel_id, title) VALUES (?, '新城')").run(novelId).lastInsertRowid)
})
afterEach(() => db.close())

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const router = express.Router()
  registerChapterBackfillRoutes(router, db)
  const app = express()
  app.use(express.json())
  app.use('/api/novels', router)
  app.use(apiErrorMiddleware)
  const server: Server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as { port: number }
  try { await fn(`http://127.0.0.1:${port}/api/novels`) }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
function review(base: string, factId: number, action: string, expectedContent: string, ownerId = novelId) {
  return fetch(`${base}/${ownerId}/facts/${factId}/review`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedContent })
  })
}
function extraction() {
  return { characterStates: [], newFacts: [{ content: '蓝色钥匙在船长手中' }], foreshadows: [], paidForeshadows: [], factionStates: [] }
}

describe('AI 事实人工确认', () => {
  it('只新增未确认事实，跳过空白和重复，不降级历史已确认事实', () => {
    db.prepare('INSERT INTO fact (novel_id, chapter_id, content, confirmed) VALUES (?, ?, ?, 1)').run(novelId, chapterId, '已有手工事实')
    expect(writePendingFacts(db, novelId, chapterId, [
      { content: ' AI 候选事实 ' }, { content: 'AI 候选事实' }, { content: ' ' }, { content: '已有手工事实' }
    ])).toBe(1)
    expect(db.prepare('SELECT content, confirmed FROM fact ORDER BY id').all()).toEqual([
      { content: '已有手工事实', confirmed: 1 }, { content: 'AI 候选事实', confirmed: 0 }
    ])
    expect(writePendingFacts(db, novelId, chapterId, [{ content: 'AI 候选事实' }])).toBe(0)
    expect(listPendingFacts(db, novelId)[0]).toMatchObject({ content: 'AI 候选事实', chapterId, chapterTitle: '旧城' })
  })

  it('写作上下文排除待确认事实，逐条确认后才纳入，且不注入未来章节事实', () => {
    writePendingFacts(db, novelId, chapterId, [{ content: '独有候选事实' }])
    db.prepare('INSERT INTO fact (novel_id, content, confirmed) VALUES (?, ?, 1)').run(novelId, '已确认手工设定')
    db.prepare('INSERT INTO fact (novel_id, chapter_id, content, confirmed) VALUES (?, ?, ?, 1)').run(novelId, nextChapterId, '未来章节事实')
    const prompt = () => buildChapterWriteContext(db, novelId, nextChapterId).messages.map(message => message.content).join('\n')
    expect(prompt()).toContain('已确认手工设定')
    expect(prompt()).not.toContain('独有候选事实')
    expect(prompt()).not.toContain('未来章节事实')
    const fact = listPendingFacts(db, novelId)[0]
    expect(reviewFact(db, novelId, fact.id, { action: 'confirm', expectedContent: fact.content })).toBe('changed')
    expect(prompt()).toContain('【已确认事实（必须遵守，不得矛盾）】')
    expect(prompt()).toContain('独有候选事实')
  })

  it('确认端点幂等，两个面板均移除已确认项，角色状态确认不会确认事实', async () => {
    writePendingFacts(db, novelId, chapterId, [{ content: '需要核对' }])
    const fact = listPendingFacts(db, novelId)[0]
    await withServer(async base => {
      const characters = await fetch(`${base}/${novelId}/confirm-state`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterStates: [] })
      })
      expect(characters.status).toBe(200)
      expect(listPendingFacts(db, novelId)).toHaveLength(1)
      expect(await (await review(base, fact.id, 'confirm', fact.content)).json()).toEqual({ ok: true, changed: true })
      expect(await (await review(base, fact.id, 'confirm', fact.content)).json()).toEqual({ ok: true, changed: false })
      for (const panel of ['pending', 'memory']) {
        const response = await fetch(`${base}/${novelId}/${panel}`)
        expect(await response.json()).toMatchObject({ pendingFacts: [] })
      }
      expect(db.prepare('SELECT confirmed FROM fact WHERE id = ?').get(fact.id)).toEqual({ confirmed: 1 })
    })
  })

  it('拒绝只移除未确认事实，不能删除已确认历史事实', async () => {
    writePendingFacts(db, novelId, chapterId, [{ content: '误读' }, { content: '保留' }])
    const [rejected, confirmed] = listPendingFacts(db, novelId)
    reviewFact(db, novelId, confirmed.id, { action: 'confirm', expectedContent: confirmed.content })
    await withServer(async base => {
      expect((await review(base, rejected.id, 'reject', rejected.content)).status).toBe(200)
      expect((await review(base, confirmed.id, 'reject', confirmed.content)).status).toBe(409)
      expect(db.prepare('SELECT content, confirmed FROM fact').all()).toEqual([{ content: '保留', confirmed: 1 }])
    })
  })

  it('跨书、陈旧原文、非法动作和非法 ID 均不能确认事实', async () => {
    writePendingFacts(db, novelId, chapterId, [{ content: '待核对原文' }])
    const fact = listPendingFacts(db, novelId)[0]
    await withServer(async base => {
      expect((await review(base, fact.id, 'confirm', fact.content, novelId + 1000)).status).toBe(404)
      expect((await review(base, fact.id, 'confirm', '旧内容')).status).toBe(409)
      expect((await review(base, fact.id, 'automatic', fact.content)).status).toBe(400)
      expect((await review(base, -1, 'confirm', fact.content)).status).toBe(400)
      expect(listPendingFacts(db, novelId)).toHaveLength(1)
    })
  })

  it('手动 AI 回灌写入未确认区并保留来源章节，重复提取不重复写事实', async () => {
    vi.mocked(callLlmJson).mockResolvedValue(extraction())
    await withServer(async base => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await fetch(`${base}/${novelId}/chapters/${chapterId}/backfill`, { method: 'POST' })
        expect(result.status).toBe(200)
      }
      const result = await fetch(`${base}/${novelId}/pending`)
      expect(await result.json()).toMatchObject({ pendingFacts: [{ content: '蓝色钥匙在船长手中', chapterId, chapterTitle: '旧城' }] })
      expect(db.prepare('SELECT confirmed FROM fact').all()).toEqual([{ confirmed: 0 }])
    })
  })

  it('AI 提取期间正文改动时返回 409，不写入过时事实或伏笔', async () => {
    vi.mocked(callLlmJson).mockImplementation(async () => {
      db.prepare('UPDATE chapter SET content = ? WHERE id = ?').run('改写后的正文', chapterId)
      return extraction()
    })
    await withServer(async base => {
      expect((await fetch(`${base}/${novelId}/chapters/${chapterId}/backfill`, { method: 'POST' })).status).toBe(409)
      expect(db.prepare('SELECT * FROM fact').all()).toEqual([])
      expect(db.prepare('SELECT * FROM foreshadow').all()).toEqual([])
    })
  })
})
