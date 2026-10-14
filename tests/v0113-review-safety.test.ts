import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { applyMigrations } from '../server/src/db/migrate'
import { seedIfEmpty } from '../server/src/db/seed'
import { registerChapterReviewRoutes } from '../server/src/routes/chapters/review'
import { apiErrorMiddleware } from '../server/src/services/apiError'
import { callLlmJson } from '../server/src/services/jsonSafe'
import { createAgentsRouter } from '../server/src/routes/agents'

vi.mock('../server/src/services/jsonSafe', () => ({ callLlmJson: vi.fn() }))
vi.mock('../server/src/services/context/dynamic', () => ({ buildChapterReviewContext: () => [], buildFixContext: () => [] }))

beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.restoreAllMocks())

async function withFixture(test: (db: DatabaseSync, chapterId: number, url: string) => Promise<void>) {
  const db = new DatabaseSync(':memory:', { timeout: 5000, enableForeignKeyConstraints: true })
  applyMigrations(db); seedIfEmpty(db)
  const novelId = Number(db.prepare("INSERT INTO novel(title) VALUES ('审核归属测试')").run().lastInsertRowid)
  const chapterId = Number(db.prepare("INSERT INTO chapter(novel_id,title,content,status,goal_json) VALUES (?, '章', '原稿', 'written', ?)")
    .run(novelId, JSON.stringify({ scenes: ['一', '二'] })).lastInsertRowid)
  const app = express(); const router = express.Router()
  app.use(express.json()); registerChapterReviewRoutes(router, db); app.use('/api/novels', router); app.use(apiErrorMiddleware)
  app.use('/api/team-tests', createAgentsRouter(db)); app.use(apiErrorMiddleware)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/novels/${novelId}/chapters/${chapterId}`
  try { await test(db, chapterId, url) }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close() }
}

describe('审核结果条件提交', () => {
  it.each(['content', 'goal_json'])('模型等待期间 %s 变化返回409，旧审核和质量债均不落库', async field => {
    await withFixture(async (db, chapterId, url) => {
      const currentReview = JSON.stringify({ score: 99, issues: [], label: '新审核' })
      vi.mocked(callLlmJson).mockImplementationOnce(async () => {
        const value = field === 'content' ? '人工新稿' : JSON.stringify({ scenes: ['新场景'] })
        db.prepare(`UPDATE chapter SET ${field}=?, review_json=? WHERE id=?`).run(value, currentReview, chapterId)
        return { score: 30, strengths: [], issues: [{ severity: 'high', location: '旧稿', problem: '过时问题', suggestion: '改' }], needsFix: true }
      })
      const response = await fetch(`${url}/review`, { method: 'POST' })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'CHAPTER_CONTENT_CONFLICT' })
      expect(db.prepare('SELECT review_json,status FROM chapter WHERE id=?').get(chapterId))
        .toMatchObject({ review_json: currentReview, status: 'written' })
      expect(db.prepare('SELECT COUNT(*) AS c FROM quality_debt WHERE chapter_id=?').get(chapterId)?.c).toBe(0)
    })
  })

  it('场景结构问题与审核一次提交；重复审核不重复登记场景质量债', async () => {
    await withFixture(async (db, chapterId, url) => {
      vi.mocked(callLlmJson).mockImplementation(async () => ({ score: 90, strengths: [], issues: [], needsFix: false }))
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${url}/review`, { method: 'POST' })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ review: { needsFix: true, issues: [expect.objectContaining({ severity: 'high' })] } })
      }
      const row = db.prepare('SELECT review_json,status FROM chapter WHERE id=?').get(chapterId)
      expect(JSON.parse(String(row?.review_json)).needsFix).toBe(true)
      expect(row?.status).toBe('reviewed')
      expect(db.prepare('SELECT COUNT(*) AS c FROM quality_debt WHERE chapter_id=?').get(chapterId)?.c).toBe(1)
    })
  })

  it('预算耗尽的 HTTP 修复入口明确提示两轮额度，不调用模型', async () => {
    await withFixture(async (db, chapterId, url) => {
      db.prepare('UPDATE chapter SET fix_history_json=?, review_json=? WHERE id=?')
        .run('[{"round":1},{"round":2}]', JSON.stringify({ score: 30, issues: [] }), chapterId)
      const response = await fetch(`${url}/fix`, { method: 'POST' })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('每章 2 轮')
      expect(callLlmJson).not.toHaveBeenCalled()
    })
  })

  it.each(['content', 'goal_json', 'status'])('团队审核等待期间 %s 变化返回409，不落旧审核或质量债', async field => {
    await withFixture(async (db, chapterId, url) => {
      const novelId = Number(db.prepare('SELECT novel_id FROM chapter WHERE id=?').get(chapterId)?.novel_id)
      const oldReview = JSON.stringify({ score: 88, issues: [], label: '应保留的审核' })
      db.prepare('UPDATE chapter SET review_json=? WHERE id=?').run(oldReview, chapterId)
      let changed = false
      vi.mocked(callLlmJson).mockImplementation(async (_db, _type, _opts, _parse, label) => {
        if (label === 'team-editor') return { constraint: '测试用的主编创作约束内容' }
        if (!changed) {
          changed = true
          const value = field === 'content' ? '人工新稿' : field === 'goal_json' ? '{"scenes":["新场景"]}' : 'generating'
          db.prepare(`UPDATE chapter SET ${field}=? WHERE id=?`).run(value, chapterId)
        }
        return { score: 30, issues: [{ severity: 'high', location: '旧稿', problem: '过时问题', suggestion: '改' }] }
      })
      const endpoint = `${new URL(url).origin}/api/team-tests/${novelId}/team/review`
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chapterId }) })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'CHAPTER_CONTENT_CONFLICT' })
      expect(db.prepare('SELECT review_json FROM chapter WHERE id=?').get(chapterId)?.review_json).toBe(oldReview)
      expect(db.prepare('SELECT COUNT(*) AS c FROM quality_debt WHERE chapter_id=?').get(chapterId)?.c).toBe(0)
    })
  })

  it('团队审核原稿未变化正常提交，重复审核不会重复登记同一质量债', async () => {
    await withFixture(async (db, chapterId, url) => {
      const novelId = Number(db.prepare('SELECT novel_id FROM chapter WHERE id=?').get(chapterId)?.novel_id)
      vi.mocked(callLlmJson).mockImplementation(async (_db, _type, _opts, _parse, label) => {
        if (label === 'team-editor') return { constraint: '测试用的主编创作约束内容' }
        return { score: 30, issues: [{ severity: 'high', location: '原稿', problem: '需要修复的问题', suggestion: '改' }] }
      })
      const endpoint = `${new URL(url).origin}/api/team-tests/${novelId}/team/review`
      for (let i = 0; i < 2; i++) {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chapterId }) })
        expect(response.status).toBe(200)
        expect((await response.json()).review.score).toBe(30)
      }
      expect(db.prepare('SELECT status FROM chapter WHERE id=?').get(chapterId)?.status).toBe('reviewed')
      expect(JSON.parse(String(db.prepare('SELECT review_json FROM chapter WHERE id=?').get(chapterId)?.review_json)).score).toBe(30)
      expect(db.prepare('SELECT COUNT(*) AS c FROM quality_debt WHERE chapter_id=?').get(chapterId)?.c).toBe(1)
    })
  })
})
