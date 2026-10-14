// v1.1.3（修复预算）：所有 AI 修复共用章节级额度；先持久预占，再调用模型。
// patch→整章降级→重审属于一轮；初始生成和底层有限传输/JSON 重试不另计轮数。
// 失败、冲突及崩溃均不退额度，遗留 claimed 不自动释放；人工正文编辑不受限制。
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const MAX_REPAIR_ROUNDS = 2

export interface RepairIssue {
  severity: string
  problem: string
  suggestion: string
  location?: string
}

type RepairSource = 'production' | 'debt-fix' | 'anti-ai'
type RepairStatus = 'claimed' | 'completed' | 'failed' | 'conflicted' | 'rejected'
type RepairRecord = Record<string, unknown> & {
  round?: number
  signature?: string
  issueKeys?: string[]
  claimId?: string
  status?: RepairStatus
}

export type RepairDenialReason = 'chapter not found' | 'rounds exceeded' | 'same signature'
  | 'repair in progress' | 'invalid repair history' | 'chapter changed'

export type RepairClaim = {
  claimed: true
  claimId: string
  chapterId: number
  novelId: number
  round: number
  issues: RepairIssue[]
} | { claimed: false; round: number; reason: RepairDenialReason }

function normalizeProblem(problem: string): string {
  return problem.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 不依赖模型返回的顺序/重复条目；保留同问题最高严重程度。 */
export function deduplicateRepairIssues(value: unknown): RepairIssue[] {
  if (!Array.isArray(value)) return []
  const issues = new Map<string, RepairIssue>()
  const severityRank = (severity: string): number => severity === 'high' ? 3 : severity === 'medium' ? 2 : 1
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const problem = typeof raw.problem === 'string' ? raw.problem.trim() : ''
    const key = normalizeProblem(problem)
    if (!key) continue
    const issue = {
      severity: String(raw.severity ?? 'medium'),
      problem,
      suggestion: String(raw.suggestion ?? ''),
      location: String(raw.location ?? '')
    }
    const previous = issues.get(key)
    if (!previous || severityRank(issue.severity) > severityRank(previous.severity)) issues.set(key, issue)
  }
  return [...issues.values()]
}

function parseHistory(raw: string): RepairRecord[] | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && !Array.isArray(item))
      ? parsed as RepairRecord[] : null
  } catch {
    // 无法证明剩余额度时拒绝，不把坏 JSON 当空历史清零。
    return null
  }
}

function issueKey(problem: string): string {
  return createHash('sha256').update(normalizeProblem(problem)).digest('hex')
}

/** 单条条件 UPDATE 是额度抢占点；不持有跨 await 的数据库事务。 */
export function claimRepairRound(
  db: DatabaseSync,
  novelId: number,
  chapterId: number,
  input: { source: RepairSource; issues: unknown; expectedContent?: string }
): RepairClaim {
  const row = db.prepare('SELECT content, status, fix_history_json FROM chapter WHERE id=? AND novel_id=?')
    .get(chapterId, novelId) as { content: string; status: string; fix_history_json: string } | undefined
  if (!row) return { claimed: false, round: 0, reason: 'chapter not found' }
  const history = parseHistory(row.fix_history_json)
  if (!history) return { claimed: false, round: MAX_REPAIR_ROUNDS, reason: 'invalid repair history' }
  const denied = (reason: RepairDenialReason): RepairClaim => ({ claimed: false, round: history.length, reason })
  if (input.expectedContent !== undefined && row.content !== input.expectedContent) return denied('chapter changed')
  if (history.length >= MAX_REPAIR_ROUNDS) return denied('rounds exceeded')
  if (history.some(entry => entry.status === 'claimed')) return denied('repair in progress')
  if (input.source !== 'anti-ai' && row.status === 'generating') return denied('chapter changed')

  const allIssues = deduplicateRepairIssues(input.issues)
  const knownKeys = new Set(history.flatMap(entry => Array.isArray(entry.issueKeys) ? entry.issueKeys : []))
  // 旧版只存前三个问题的前 30 字；兼容其签名，不能因升级恢复已经花掉的额度。
  const legacyProblems = new Set(history.flatMap(entry =>
    !entry.claimId && typeof entry.signature === 'string' ? entry.signature.split('|').map(normalizeProblem) : []))
  const issues = allIssues.filter(issue => !knownKeys.has(issueKey(issue.problem))
    && !legacyProblems.has(normalizeProblem(issue.problem.slice(0, 30))))
  if (allIssues.length > 0 && issues.length === 0) return denied('same signature')
  const issueKeys = issues.map(issue => issueKey(issue.problem)).sort()
  const signature = createHash('sha256').update(JSON.stringify(issueKeys)).digest('hex')
  if (history.some(entry => entry.signature === signature)) return denied('same signature')

  const claimId = randomUUID()
  const round = history.length + 1
  const nextHistory = [...history, {
    round, issues: issues.length, signature, issueKeys, claimId, source: input.source,
    status: 'claimed', startedAt: new Date().toISOString()
  }]
  const updated = db.prepare(
    "UPDATE chapter SET fix_history_json=?, updated_at=datetime('now') WHERE id=? AND novel_id=? AND fix_history_json=? AND content=? AND status=?"
  ).run(JSON.stringify(nextHistory), chapterId, novelId, row.fix_history_json, row.content, row.status)
  if (!updated.changes) return denied('chapter changed')
  return { claimed: true, claimId, chapterId, novelId, round, issues }
}

/** 仅结算自己的预占，不重写正文、不删除历史；失败时保留 claimed 即可安全停止。 */
export function finishRepairRound(
  db: DatabaseSync,
  claim: Extract<RepairClaim, { claimed: true }>,
  status: Exclude<RepairStatus, 'claimed'>,
  score?: number
): boolean {
  const row = db.prepare('SELECT fix_history_json FROM chapter WHERE id=? AND novel_id=?')
    .get(claim.chapterId, claim.novelId) as { fix_history_json: string } | undefined
  if (!row) return false
  const history = parseHistory(row.fix_history_json)
  if (!history) return false
  const entry = history.find(item => item.claimId === claim.claimId)
  if (!entry || entry.status !== 'claimed') return false
  entry.status = status
  entry.finishedAt = new Date().toISOString()
  if (score !== undefined && Number.isFinite(score)) entry.score = score
  return Boolean(db.prepare(
    "UPDATE chapter SET fix_history_json=?, updated_at=datetime('now') WHERE id=? AND novel_id=? AND fix_history_json=?"
  ).run(JSON.stringify(history), claim.chapterId, claim.novelId, row.fix_history_json).changes)
}

/** 同一未解决质量债只保留一条；重复点击/重启不追加相同告警。 */
export function recordRepairDebt(db: DatabaseSync, chapterId: number, issue: string, severity = 'high'): void {
  db.prepare(
    `INSERT INTO quality_debt (chapter_id, issue, severity, resolved)
     SELECT ?, ?, ?, 0 WHERE NOT EXISTS (
       SELECT 1 FROM quality_debt WHERE chapter_id=? AND issue=? AND resolved=0
     )`
  ).run(chapterId, issue, severity, chapterId, issue)
}

export function describeRepairDenial(reason: RepairDenialReason): string {
  switch (reason) {
    case 'rounds exceeded': return `AI 修复已用完每章 ${MAX_REPAIR_ROUNDS} 轮额度，请人工修改或重新规划；人工编辑不受限。`
    case 'same signature': return '同类问题已经尝试修复，停止重复调用，请人工检查。'
    case 'repair in progress': return '该章修复仍在执行，或上次中断后结果未确认；为避免重复花费已暂停 AI 修复，人工编辑不受限。'
    case 'invalid repair history': return '修复历史损坏，无法确认剩余额度；已停止 AI 修复，人工编辑不受限。'
    case 'chapter changed': return '正文或执行状态已变化，停止基于旧稿的 AI 修复。'
    case 'chapter not found': return '章节不存在。'
  }
}
