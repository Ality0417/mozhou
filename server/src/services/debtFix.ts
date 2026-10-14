// v0.10.0（批B/I2）：质量债自动修复闭环
// 业界模式：evaluator-optimizer（Anthropic Building Effective Agents 查证，D81）
// 停止条件（官方建议"maximum number of iterations"）：
//   ① 每章最多 2 轮修复（fix_history 上限，P12 C1 既有）
//   ② 同签名问题防重复烧 LLM（P12 C1 既有）
//   ③ 修复后重审 score≥75 达标即止（P1.5 既有）
// 本服务把 chapters.ts 的 /fix 路由核心抽为可复用函数（路由与 job 共用）

import { DatabaseSync } from 'node:sqlite'
import { buildChapterReviewContext, buildFixContext } from './context/dynamic'
import { callLlmJson } from './jsonSafe'
import { persistCandidateVersion } from './chapterGeneration/persistence'
import { claimRepairRound, finishRepairRound, deduplicateRepairIssues, recordRepairDebt, describeRepairDenial } from './repairBudget'
import { countNovelWords } from './writingProfile'
import { isFixWarranted } from './reviewPolicy'

const PASS_SCORE = 75

export interface FixRoundResult {
  fixed: boolean
  round: number
  content: string
  score: number
  passed: boolean
  reason?: string
  message?: string
  candidateVersionId?: number
}

/** 单章修复一轮（含上限/签名防重/重审/债务 resolve）；返回 round 信息 */
export async function fixChapterOnce(
  db: DatabaseSync,
  novelId: number,
  chapterId: number,
  opts: { automatic?: boolean } = {}
): Promise<FixRoundResult> {
  const chapter = db
    .prepare('SELECT content, review_json, fix_history_json FROM chapter WHERE id = ? AND novel_id = ?')
    .get(chapterId, novelId) as
    | { content: string; review_json: string; fix_history_json: string }
    | undefined
  if (!chapter) return { fixed: false, round: 0, content: '', score: 0, passed: false, reason: 'chapter not found' }
  if (!chapter.content.trim()) return { fixed: false, round: 0, content: '', score: 0, passed: false, reason: 'empty chapter' }

  // 正文改变后审核会失效；历史质量债不能授权对新稿进行无依据的泛化重写。
  let review: { score: number; issues?: unknown }
  try {
    const parsed: unknown = JSON.parse(chapter.review_json || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof (parsed as { score?: unknown }).score !== 'number'
      || !Number.isFinite((parsed as { score: number }).score)) throw new Error('invalid review')
    review = parsed as { score: number; issues?: unknown }
  } catch {
    return { fixed: false, round: 0, content: chapter.content, score: 0, passed: false,
      reason: 'review required', message: '当前正文没有有效审核，请先重新审核；本次未调用 AI 修复，也未消耗修复额度。' }
  }
  const issues = deduplicateRepairIssues(review.issues)
  if (typeof review.score === 'number' && Number.isFinite(review.score)
    && (review.score >= PASS_SCORE || (opts.automatic && !isFixWarranted(review.score, issues)))) {
    return { fixed: false, round: 0, content: chapter.content, score: review.score, passed: review.score >= PASS_SCORE,
      reason: 'repair not warranted', message: '本章审核已达标或没有需要自动修复的高优先级问题，已停止重复调用。' }
  }
  // ①+②：生产/反 AI/债务/手动 AI 修复共用额度，调用之前持久预占。
  const claim = claimRepairRound(db, novelId, chapterId, { source: 'debt-fix', issues, expectedContent: chapter.content })
  if (!claim.claimed) {
    const message = describeRepairDenial(claim.reason)
    if (claim.reason !== 'chapter not found' && claim.reason !== 'chapter changed') recordRepairDebt(db, chapterId, message)
    return { fixed: false, round: claim.round, content: chapter.content, score: 0, passed: false, reason: claim.reason, message }
  }
  try {
    // ③ LLM 修复：仅处理未尝试过的问题。
    const messages = buildFixContext(db, novelId, chapterId, chapter.content, claim.issues)
    const fixed = await callLlmJson<{ content: string }>(
      db,
      'extraction',
      {
        novelId,
        messages,
        maxTokens: 8192
      },
      (obj) => {
        const r = obj as Record<string, unknown>
        if (typeof r.content === 'string' && r.content.length > 100) return { content: r.content }
        return null
      },
      'fix'
    )
    // v0.22.0（审查 N1·本地设计决策）：修复重写整章→覆盖语义（防多轮修复膨胀；见 generate.ts 注释）
    const fixedWordCount = countNovelWords(db, novelId, fixed.content)
    const contentChanged = Number(fixed.content !== chapter.content)
    const committed = db.prepare(
      "UPDATE chapter SET content = ?, word_count = ?, ai_words = ?, human_words = 0, review_json = CASE WHEN ? THEN '{}' ELSE review_json END, status = CASE WHEN ? THEN 'written' ELSE status END, updated_at = datetime('now') WHERE id = ? AND novel_id = ? AND content = ? AND status != 'generating'"
    ).run(fixed.content, fixedWordCount, fixedWordCount, contentChanged, contentChanged, chapterId, novelId, chapter.content)
    if (!committed.changes) {
      const candidateVersionId = persistCandidateVersion(db, chapterId, fixed.content, 'AI 待采用：修复期间正文已修改')
      finishRepairRound(db, claim, 'conflicted')
      return { fixed: false, candidateVersionId, round: claim.round, content: fixed.content, score: 0, passed: false, reason: '正文已修改，AI 修复结果已保留在版本历史' }
    }

    // ④ 重审闭环：score≥75 或达轮数上限停止
    const reviewMessages = buildChapterReviewContext(db, novelId, chapterId, fixed.content)
    const rescore = await callLlmJson<{
      score: number
      strengths: string[]
      issues: Array<{ severity: string; location: string; problem: string; suggestion: string }>
      needsFix: boolean
    }>(
      db,
      'extraction',
      {
        novelId,
        messages: reviewMessages,
        maxTokens: 4096
      },
      (obj) => {
        const r = obj as Record<string, unknown>
        if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return null
        return {
          score: Number(r.score),
          strengths: Array.isArray(r.strengths) ? (r.strengths as string[]) : [],
          issues: deduplicateRepairIssues(r.issues).map(issue => ({ ...issue, location: issue.location ?? '' })),
          needsFix: isFixWarranted(r.score, deduplicateRepairIssues(r.issues))
        }
      },
      'review'
    )
    const reviewCommitted = db.prepare("UPDATE chapter SET review_json = ?, status = 'reviewed', updated_at = datetime('now') WHERE id = ? AND novel_id = ? AND content = ? AND status != 'generating'").run(
      JSON.stringify(rescore),
      chapterId,
      novelId,
      fixed.content
    )
    const passed = Boolean(reviewCommitted.changes) && rescore.score >= PASS_SCORE
    // ⑤ 达标 → 该章未解决债务 resolved（质量债可消费闭环）
    if (passed && reviewCommitted.changes) {
      // v0.23.1（批次 B7/e2e R4 发现）：quality_debt 表无 updated_at 列（仅 created_at）——
      // 此前带 updated_at 的 UPDATE 必抛 no such column → 修复链路 500（v0.10.0 引入，
      // 历史轮 rescore 未达标而绕过未暴露）
      db.prepare('UPDATE quality_debt SET resolved = 1 WHERE chapter_id = ? AND resolved = 0').run(chapterId)
    } else if (reviewCommitted.changes) {
      for (const issue of deduplicateRepairIssues(rescore.issues)) {
        if (issue.severity === 'high' || issue.severity === 'medium') recordRepairDebt(db, chapterId, issue.problem, issue.severity)
      }
    }
    finishRepairRound(db, claim, reviewCommitted.changes ? 'completed' : 'conflicted', rescore.score)
    return { fixed: true, round: claim.round, content: fixed.content, score: rescore.score, passed }
  } catch (error) {
    finishRepairRound(db, claim, 'failed')
    recordRepairDebt(db, chapterId, 'AI 修复或重审未完成，本轮额度已消耗；请检查正文与审核结果后人工处理。')
    throw error
  }
}

/** 整本书质量债自动修复（job 处理入口）：未解决债务章节 → 逐章修复（每章内部自限轮次） */
export async function fixAllDebts(
  db: DatabaseSync,
  novelId: number,
  onProgress: (done: number, total: number, current: string, action: string) => void
): Promise<{ fixed: number; skipped: number; failed: number }> {
  const debts = db
    .prepare(
      `SELECT DISTINCT q.chapter_id, c.title FROM quality_debt q
       JOIN chapter c ON c.id = q.chapter_id
       WHERE q.resolved = 0 AND c.novel_id = ? ORDER BY q.chapter_id`
    )
    .all(novelId) as Array<{ chapter_id: number; title: string }>
  const total = debts.length
  let done = 0
  let fixed = 0
  let failed = 0
  let skipped = 0
  for (const d of debts) {
    onProgress(done, total, d.title || `第 ${d.chapter_id} 章`, '自动修复')
    try {
      const r = await fixChapterOnce(db, novelId, d.chapter_id, { automatic: true })
      if (r.passed) fixed += 1
      else if (!r.fixed && !r.candidateVersionId) skipped += 1
      else failed += 1
    } catch (err) {
      console.warn(`[debt-fix] 第 ${d.chapter_id} 章修复失败: ${err instanceof Error ? err.message : String(err)}`)
      failed += 1
    }
    done += 1
  }
  return { fixed, skipped, failed }
}
