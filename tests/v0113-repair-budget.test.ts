import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../server/src/db/migrate'
import { seedIfEmpty } from '../server/src/db/seed'
import { claimRepairRound, finishRepairRound, deduplicateRepairIssues, recordRepairDebt } from '../server/src/services/repairBudget'
import { commitChapterSave } from '../server/src/services/chapterSave'
import { fixChapterOnce, fixAllDebts } from '../server/src/services/debtFix'
import { runProductionPipeline } from '../server/src/services/production/pipeline'
import { postProcessGeneratedContent } from '../server/src/services/chapterGeneration/postProcess'
import { callLlmJson } from '../server/src/services/jsonSafe'
import { generateChapter } from '../server/src/services/chapterGeneration/orchestrator'
import { buildFixContext } from '../server/src/services/context/dynamic'

vi.mock('../server/src/services/jsonSafe', () => ({ callLlmJson: vi.fn() }))
vi.mock('../server/src/services/chapterGeneration/orchestrator', () => ({ generateChapter: vi.fn() }))
vi.mock('../server/src/services/context/dynamic', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/src/services/context/dynamic')>()
  return { ...actual, buildChapterReviewContext: () => [], buildFixContext: vi.fn(() => []), buildPatchContext: () => [], buildBackfillContext: () => [] }
})

const databases: DatabaseSync[] = []
const directories: string[] = []
const issue = (problem: string) => ({ severity: 'high', problem, suggestion: '修改' })
const original = '原始章节正文。'.repeat(60)
const fixed = '修复后的正文。'.repeat(60)
const styleFeatures = JSON.stringify([{ id: 'rhythm', name: '节奏', description: '短句', enabled: true, category: 'rhythm' }])

function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true })
  databases.push(db)
  return db
}

function fixture(content = original, path = ':memory:') {
  const db = openDb(path)
  applyMigrations(db)
  seedIfEmpty(db)
  const novelId = Number(db.prepare("INSERT INTO novel(title) VALUES ('修复预算隔离测试')").run().lastInsertRowid)
  const chapterId = Number(db.prepare("INSERT INTO chapter(novel_id,title,content,status,review_json) VALUES (?, '章', ?, 'written', ?)")
    .run(novelId, content, JSON.stringify({ score: 40, issues: [issue('动机矛盾')] })).lastInsertRowid)
  return { db, novelId, chapterId }
}

function history(db: DatabaseSync, chapterId: number): Array<{ round: number; status: string; source: string; claimId: string; issueKeys: string[] }> {
  return JSON.parse(String(db.prepare('SELECT fix_history_json FROM chapter WHERE id=?').get(chapterId)?.fix_history_json))
}

function setReview(db: DatabaseSync, chapterId: number, problem: string) {
  db.prepare('UPDATE chapter SET review_json=? WHERE id=?').run(JSON.stringify({ score: 40, issues: [issue(problem)] }), chapterId)
}

beforeEach(() => vi.resetAllMocks())
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('章节级持久修复预算', () => {
  it('生产、债务与反 AI 共用两轮，失败也不返还额度', () => {
    const { db, novelId, chapterId } = fixture()
    const first = claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [issue('问题一')] })
    expect(first.claimed).toBe(true)
    if (!first.claimed) throw new Error('expected claim')
    expect(history(db, chapterId)[0]).toMatchObject({ round: 1, status: 'claimed', source: 'production' })
    finishRepairRound(db, first, 'failed')
    const second = claimRepairRound(db, novelId, chapterId, { source: 'debt-fix', issues: [issue('问题二')] })
    if (!second.claimed) throw new Error('expected claim')
    finishRepairRound(db, second, 'completed', 80)
    expect(claimRepairRound(db, novelId, chapterId, { source: 'anti-ai', issues: [issue('问题三')] }))
      .toEqual({ claimed: false, round: 2, reason: 'rounds exceeded' })
    expect(history(db, chapterId)).toHaveLength(2)
  })

  it('两个连接读到相同历史时只有一个 CAS 预占成功', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-repair-cas-')); directories.push(directory)
    const path = join(directory, 'test.db')
    const { db, novelId, chapterId } = fixture(original, path)
    const other = openDb(path)
    const prepare = db.prepare.bind(db)
    let competingClaim: ReturnType<typeof claimRepairRound> | undefined
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('UPDATE chapter SET fix_history_json=') && !competingClaim) {
        competingClaim = claimRepairRound(other, novelId, chapterId, { source: 'debt-fix', issues: [issue('另一问题')] })
      }
      return prepare(sql)
    })
    const lost = claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [issue('问题')] })
    expect(competingClaim?.claimed).toBe(true)
    expect(lost).toMatchObject({ claimed: false, reason: 'chapter changed' })
    expect(history(db, chapterId)).toHaveLength(1)
  })

  it('重启后的未结算预占保持停止，不猜测未发生调用或释放额度', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-repair-restart-')); directories.push(directory)
    const path = join(directory, 'test.db')
    const { db, novelId, chapterId } = fixture(original, path)
    claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [issue('问题一')] })
    db.close(); databases.splice(databases.indexOf(db), 1)
    const reopened = openDb(path)
    expect(claimRepairRound(reopened, novelId, chapterId, { source: 'debt-fix', issues: [issue('新问题')] }))
      .toEqual({ claimed: false, round: 1, reason: 'repair in progress' })
    expect(history(reopened, chapterId)).toHaveLength(1)
  })

  it('规范化问题去重，换顺序/大小写/空白或重复条目不能绕过', () => {
    const { db, novelId, chapterId } = fixture()
    const first = claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [issue('Plot  Hole'), issue('矛盾'), issue(' plot hole ')] })
    if (!first.claimed) throw new Error('expected claim')
    expect(first.issues).toHaveLength(2)
    finishRepairRound(db, first, 'completed')
    expect(claimRepairRound(db, novelId, chapterId, { source: 'debt-fix', issues: [issue('矛盾'), issue('PLOT HOLE')] }))
      .toMatchObject({ claimed: false, reason: 'same signature' })
    const next = claimRepairRound(db, novelId, chapterId, { source: 'debt-fix', issues: [issue('矛盾'), issue('新问题')] })
    expect(next).toMatchObject({ claimed: true, issues: [expect.objectContaining({ problem: '新问题' })] })
  })

  it('旧历史轮数和旧签名保留效力', () => {
    const { db, novelId, chapterId } = fixture()
    db.prepare('UPDATE chapter SET fix_history_json=? WHERE id=?').run(JSON.stringify([{ round: 1, issues: 1, signature: '动机矛盾' }]), chapterId)
    expect(claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [issue('动机矛盾')] }))
      .toMatchObject({ claimed: false, round: 1, reason: 'same signature' })
    db.prepare('UPDATE chapter SET fix_history_json=? WHERE id=?').run('[{"round":1},{"round":2}]', chapterId)
    expect(claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [] }))
      .toMatchObject({ claimed: false, round: 2, reason: 'rounds exceeded' })
  })

  it.each(['', '{bad', '{}', 'null', '[null]', '[42]'])('损坏历史 %s 不重置预算', raw => {
    const { db, novelId, chapterId } = fixture()
    db.prepare('UPDATE chapter SET fix_history_json=? WHERE id=?').run(raw, chapterId)
    expect(claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [] }))
      .toMatchObject({ claimed: false, reason: 'invalid repair history' })
    expect(db.prepare('SELECT fix_history_json FROM chapter WHERE id=?').get(chapterId)?.fix_history_json).toBe(raw)
  })

  it('原文变化不占预算；额度用完仍允许人工正文保存', () => {
    const { db, novelId, chapterId } = fixture()
    expect(claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [], expectedContent: '过期稿' }))
      .toMatchObject({ claimed: false, reason: 'chapter changed' })
    db.prepare('UPDATE chapter SET fix_history_json=? WHERE id=?').run('[{"round":1},{"round":2}]', chapterId)
    commitChapterSave(db, novelId, chapterId, { expectedContent: original, operationId: 'manual-edit' }, { content: '人工新稿' }, () => {
      db.prepare('UPDATE chapter SET content=? WHERE id=?').run('人工新稿', chapterId)
    })
    expect(db.prepare('SELECT content FROM chapter WHERE id=?').get(chapterId)?.content).toBe('人工新稿')
    expect(history(db, chapterId)).toHaveLength(2)
  })

  it('重复告警只有一条未解决质量债，清理后新告警可以登记', () => {
    const { db, chapterId } = fixture()
    recordRepairDebt(db, chapterId, '额度已用完')
    recordRepairDebt(db, chapterId, '额度已用完')
    expect(db.prepare('SELECT COUNT(*) AS c FROM quality_debt WHERE chapter_id=?').get(chapterId)?.c).toBe(1)
    db.prepare('UPDATE quality_debt SET resolved=1 WHERE chapter_id=?').run(chapterId)
    recordRepairDebt(db, chapterId, '额度已用完')
    expect(db.prepare('SELECT COUNT(*) AS c FROM quality_debt WHERE chapter_id=? AND resolved=0').get(chapterId)?.c).toBe(1)
  })

  it('坏审核条目被过滤，同问题保留高严重级别', () => {
    expect(deduplicateRepairIssues([null, {}, issue(''), { ...issue('问题'), severity: 'low' }, issue('问题')]))
      .toEqual([{ ...issue('问题'), location: '' }])
  })
})

describe('修复入口真实预算集成（模型 mock）', () => {
  it.each(['{}', 'null', '{bad', '{"score":"40"}'])('缺少当前有效审核 %s 时手动和债务入口都不花费额度', async review => {
    const { db, novelId, chapterId } = fixture()
    db.prepare('UPDATE chapter SET review_json=? WHERE id=?').run(review, chapterId)
    recordRepairDebt(db, chapterId, '旧正文遗留质量债')
    expect(await fixChapterOnce(db, novelId, chapterId)).toMatchObject({ fixed: false, reason: 'review required' })
    expect(await fixAllDebts(db, novelId, () => {})).toEqual({ fixed: 0, failed: 0, skipped: 1 })
    expect(history(db, chapterId)).toEqual([])
    expect(callLlmJson).not.toHaveBeenCalled()
    expect(db.prepare('SELECT content FROM chapter WHERE id=?').get(chapterId)?.content).toBe(original)
  })

  it('模型失败前已记一轮，重复请求和重启不再为相同问题调用模型', async () => {
    const { db, novelId, chapterId } = fixture()
    vi.mocked(callLlmJson).mockImplementationOnce(async () => {
      expect(history(db, chapterId)).toMatchObject([{ status: 'claimed', round: 1 }])
      throw new Error('模拟供应商超时')
    })
    await expect(fixChapterOnce(db, novelId, chapterId)).rejects.toThrow('模拟供应商超时')
    expect(history(db, chapterId)[0].status).toBe('failed')
    expect((await fixChapterOnce(db, novelId, chapterId)).reason).toBe('same signature')
    expect(callLlmJson).toHaveBeenCalledTimes(1)
  })

  it('手动 AI 修复并发请求不重复调用；完成后不再修已达标正文', async () => {
    const { db, novelId, chapterId } = fixture()
    let resolveFix!: (value: { content: string }) => void
    vi.mocked(callLlmJson).mockImplementationOnce(() => new Promise(resolve => { resolveFix = resolve }))
      .mockResolvedValueOnce({ score: 90, issues: [], strengths: [], needsFix: false })
    const first = fixChapterOnce(db, novelId, chapterId)
    expect((await fixChapterOnce(db, novelId, chapterId)).reason).toBe('repair in progress')
    expect(callLlmJson).toHaveBeenCalledTimes(1)
    resolveFix({ content: fixed })
    expect((await first).passed).toBe(true)
    expect((await fixChapterOnce(db, novelId, chapterId)).reason).toBe('repair not warranted')
    expect(callLlmJson).toHaveBeenCalledTimes(2)
  })

  it('正文冲突仅存候选，不退额度且不为旧稿重审', async () => {
    const { db, novelId, chapterId } = fixture()
    vi.mocked(callLlmJson).mockImplementationOnce(async () => {
      db.prepare('UPDATE chapter SET content=? WHERE id=?').run('人工新稿', chapterId)
      return { content: fixed }
    })
    const result = await fixChapterOnce(db, novelId, chapterId)
    expect(result.candidateVersionId).toBeGreaterThan(0)
    expect(history(db, chapterId)[0].status).toBe('conflicted')
    expect(callLlmJson).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT content FROM chapter WHERE id=?').get(chapterId)?.content).toBe('人工新稿')
  })

  it('修复正文落库时旧审核立即失效，重审失败不恢复旧分数且预算保留', async () => {
    const { db, novelId, chapterId } = fixture()
    db.prepare("UPDATE chapter SET status='reviewed' WHERE id=?").run(chapterId)
    vi.mocked(callLlmJson).mockResolvedValueOnce({ content: fixed }).mockImplementationOnce(async () => {
      expect(db.prepare('SELECT content,review_json,status FROM chapter WHERE id=?').get(chapterId))
        .toMatchObject({ content: fixed, review_json: '{}', status: 'written' })
      expect(history(db, chapterId)).toMatchObject([{ round: 1, status: 'claimed' }])
      throw new Error('重审尚未完成')
    })
    await expect(fixChapterOnce(db, novelId, chapterId)).rejects.toThrow('重审尚未完成')
    expect(db.prepare('SELECT review_json,status FROM chapter WHERE id=?').get(chapterId))
      .toMatchObject({ review_json: '{}', status: 'written' })
    expect(history(db, chapterId)).toMatchObject([{ round: 1, status: 'failed' }])
  })

  it('正文没有变化时不清理有效旧审核，匹配重审成功才更新评分', async () => {
    const { db, novelId, chapterId } = fixture()
    db.prepare("UPDATE chapter SET status='reviewed' WHERE id=?").run(chapterId)
    const oldReview = String(db.prepare('SELECT review_json FROM chapter WHERE id=?').get(chapterId)?.review_json)
    vi.mocked(callLlmJson).mockResolvedValueOnce({ content: original }).mockImplementationOnce(async () => {
      expect(db.prepare('SELECT review_json,status FROM chapter WHERE id=?').get(chapterId))
        .toMatchObject({ review_json: oldReview, status: 'reviewed' })
      return { score: 90, issues: [], strengths: [], needsFix: false }
    })
    expect((await fixChapterOnce(db, novelId, chapterId)).passed).toBe(true)
    expect(JSON.parse(String(db.prepare('SELECT review_json FROM chapter WHERE id=?').get(chapterId)?.review_json)).score).toBe(90)
    expect(db.prepare('SELECT status FROM chapter WHERE id=?').get(chapterId)?.status).toBe('reviewed')
    expect(history(db, chapterId)).toMatchObject([{ round: 1, status: 'completed' }])
  })

  it('两次不同问题失败后，批量债务修复跳过且不再调用模型', async () => {
    const { db, novelId, chapterId } = fixture()
    vi.mocked(callLlmJson).mockRejectedValue(new Error('模拟失败'))
    await expect(fixChapterOnce(db, novelId, chapterId)).rejects.toThrow('模拟失败')
    setReview(db, chapterId, '另一问题')
    await expect(fixChapterOnce(db, novelId, chapterId)).rejects.toThrow('模拟失败')
    setReview(db, chapterId, '第三个问题')
    expect(await fixAllDebts(db, novelId, () => {})).toEqual({ fixed: 0, failed: 0, skipped: 1 })
    expect(callLlmJson).toHaveBeenCalledTimes(2)
    expect(history(db, chapterId)).toHaveLength(2)
  })

  it('生产 patch→fallback→重审只计一轮，债务修复用第二轮并且只处理新问题', async () => {
    const { db, novelId, chapterId } = fixture('')
    vi.mocked(generateChapter).mockImplementationOnce(async () => {
      db.prepare("UPDATE chapter SET content=?, status='written' WHERE id=?").run(original, chapterId)
      return { content: original, wordCount: 360, aborted: false, usage: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 } }
    })
    vi.mocked(callLlmJson).mockImplementation(async (_db, _task, _options, _parse, label) => {
      if (label === 'production-review') return { score: 30, issues: [issue('问题一')], needsFix: true }
      if (label === 'production-patch') {
        expect(history(db, chapterId)).toMatchObject([{ status: 'claimed', round: 1 }])
        return { patches: [{ target: '不在正文中的词', replacement: '补丁' }] }
      }
      if (label === 'production-fix') return { content: fixed }
      if (label === 'production-rescore') return { score: 50, issues: [issue('问题一'), issue('问题二')], needsFix: true }
      if (label === 'production-backfill') return { characterStates: [], newFacts: [{ content: '角色住在港口' }], foreshadows: [], paidForeshadows: [] }
      if (label === 'fix') return { content: fixed + '追加修复' }
      if (label === 'review') return { score: 50, issues: [issue('问题三')], needsFix: true }
      throw new Error(`unexpected ${label}`)
    })
    await runProductionPipeline(db, novelId, () => {})
    expect(history(db, chapterId)).toMatchObject([{ source: 'production', round: 1, status: 'completed' }])
    expect(db.prepare('SELECT content, confirmed FROM fact WHERE chapter_id=?').all(chapterId))
      .toEqual([{ content: '角色住在港口', confirmed: 0 }])
    expect(JSON.parse(String(db.prepare('SELECT review_json FROM chapter WHERE id=?').get(chapterId)?.review_json)).score).toBe(50)
    expect((await fixChapterOnce(db, novelId, chapterId)).round).toBe(2)
    expect(vi.mocked(buildFixContext).mock.calls.at(-1)?.[4]).toEqual([expect.objectContaining({ problem: '问题二' })])
    const calls = vi.mocked(callLlmJson).mock.calls.length
    expect((await fixChapterOnce(db, novelId, chapterId)).reason).toBe('rounds exceeded')
    expect(callLlmJson).toHaveBeenCalledTimes(calls)
  })

  it('反 AI→生产修复耗尽两轮后，债务与反 AI 的真实入口都停止', async () => {
    const { db, novelId, chapterId } = fixture('')
    db.prepare('INSERT INTO style_asset(novel_id,name,features_json,samples_json,anti_ai_rules_json) VALUES (?, ?, ?, ?, ?)')
      .run(novelId, '测试风格', styleFeatures, '[]', JSON.stringify(['套话']))
    const antiOriginal = '套话套话套话，正文内容。'.repeat(30)
    vi.mocked(generateChapter).mockImplementationOnce(async () => {
      const processed = await postProcessGeneratedContent(db, novelId, chapterId, antiOriginal)
      db.prepare("UPDATE chapter SET content=?, status='written' WHERE id=?").run(processed.content, chapterId)
      return { content: processed.content, wordCount: 360, aborted: false, usage: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 } }
    })
    vi.mocked(callLlmJson).mockImplementation(async (_db, _task, _options, _parse, label) => {
      if (label === 'anti-ai-rewrite') return { content: original }
      if (label === 'production-review') return { score: 35, issues: [issue('角色矛盾')], needsFix: true }
      if (label === 'production-patch') return { patches: [{ target: original, replacement: fixed }] }
      if (label === 'production-rescore') return { score: 50, issues: [issue('情节新问题')], needsFix: true }
      if (label === 'production-backfill') return { characterStates: [], newFacts: [{ content: '尚待确认的事实' }], foreshadows: [], paidForeshadows: [] }
      throw new Error(`unexpected ${label}`)
    })
    await runProductionPipeline(db, novelId, () => {})
    expect(history(db, chapterId)).toMatchObject([
      { source: 'anti-ai', round: 1, status: 'completed' },
      { source: 'production', round: 2, status: 'completed' }
    ])
    expect(db.prepare('SELECT confirmed FROM fact WHERE chapter_id=?').get(chapterId)?.confirmed).toBe(0)
    const callCount = vi.mocked(callLlmJson).mock.calls.length
    expect(await fixAllDebts(db, novelId, () => {})).toMatchObject({ skipped: 1, failed: 0 })
    expect((await postProcessGeneratedContent(db, novelId, chapterId, antiOriginal)).content).toBe(antiOriginal)
    expect(callLlmJson).toHaveBeenCalledTimes(callCount)
    expect(history(db, chapterId)).toHaveLength(2)
  })

  it('生产修复重审失败保留原文与已消耗额度，债务不能重试同一问题', async () => {
    const { db, novelId, chapterId } = fixture('')
    vi.mocked(generateChapter).mockImplementationOnce(async () => {
      db.prepare("UPDATE chapter SET content=?, status='written' WHERE id=?").run(original, chapterId)
      return { content: original, wordCount: 360, aborted: false, usage: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 } }
    })
    vi.mocked(callLlmJson).mockImplementation(async (_db, _task, _options, _parse, label) => {
      if (label === 'production-review') return { score: 35, issues: [issue('角色矛盾')], needsFix: true }
      if (label === 'production-patch') return { patches: [{ target: original, replacement: fixed }] }
      if (label === 'production-rescore') throw new Error('重审失败')
      if (label === 'production-backfill') return { characterStates: [], newFacts: [], foreshadows: [], paidForeshadows: [] }
      throw new Error(`unexpected ${label}`)
    })
    await runProductionPipeline(db, novelId, () => {})
    expect(history(db, chapterId)).toMatchObject([{ source: 'production', round: 1, status: 'failed' }])
    expect(db.prepare('SELECT content FROM chapter WHERE id=?').get(chapterId)?.content).toBe(original)
    const callCount = vi.mocked(callLlmJson).mock.calls.length
    expect((await fixChapterOnce(db, novelId, chapterId)).reason).toBe('same signature')
    expect(callLlmJson).toHaveBeenCalledTimes(callCount)
  })

  it('反 AI 后处理也消耗同一预算，预算耗尽保留原文', async () => {
    const { db, novelId, chapterId } = fixture()
    db.prepare('INSERT INTO style_asset(novel_id,name,features_json,samples_json,anti_ai_rules_json) VALUES (?, ?, ?, ?, ?)')
      .run(novelId, '测试风格', styleFeatures, '[]', JSON.stringify(['套话']))
    vi.mocked(callLlmJson).mockResolvedValueOnce({ content: fixed })
    const antiOriginal = '套话套话套话，正文内容。'.repeat(20)
    const first = await postProcessGeneratedContent(db, novelId, chapterId, antiOriginal)
    expect(first.content).toBe(fixed)
    expect(history(db, chapterId)).toMatchObject([{ source: 'anti-ai', status: 'completed', round: 1 }])
    const second = claimRepairRound(db, novelId, chapterId, { source: 'production', issues: [issue('剧情问题')] })
    if (!second.claimed) throw new Error('expected claim')
    finishRepairRound(db, second, 'completed')
    const skipped = await postProcessGeneratedContent(db, novelId, chapterId, antiOriginal)
    expect(skipped.content).toBe(antiOriginal)
    expect(skipped.degradedReasons.join()).toContain('每章 2 轮')
    expect(callLlmJson).toHaveBeenCalledTimes(1)
  })

  it('超长反 AI 章节不截取前文重写，完整保留尾部且不消耗预算', async () => {
    const { db, novelId, chapterId } = fixture()
    db.prepare('INSERT INTO style_asset(novel_id,name,features_json,samples_json,anti_ai_rules_json) VALUES (?, ?, ?, ?, ?)')
      .run(novelId, '测试风格', styleFeatures, '[]', JSON.stringify(['套话']))
    const longContent = '套话套话套话' + 'An English scene must keep its ending. '.repeat(300) + 'UNIQUE ENDING'
    expect(longContent.length).toBeGreaterThan(8000)
    const result = await postProcessGeneratedContent(db, novelId, chapterId, longContent)
    expect(result.content).toBe(longContent)
    expect(result.content.endsWith('UNIQUE ENDING')).toBe(true)
    expect(result.degradedReasons.join()).toContain('8000 字符')
    expect(history(db, chapterId)).toEqual([])
    expect(callLlmJson).not.toHaveBeenCalled()
  })
})
