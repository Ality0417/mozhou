import type { DatabaseSync } from 'node:sqlite'
import type { PendingFact, FactReviewInput } from '../../../shared/src/types'

/** AI 提取只能进入待确认区；调用方负责与其他回灌产物共用事务。 */
export function writePendingFacts(
  db: DatabaseSync,
  novelId: number,
  chapterId: number,
  facts: Array<{ content: string }>
): number {
  const insert = db.prepare(
    `INSERT INTO fact (novel_id, chapter_id, content, confirmed)
     SELECT ?, ?, ?, 0 WHERE NOT EXISTS (
       SELECT 1 FROM fact WHERE novel_id = ? AND chapter_id = ? AND content = ?
     )`
  )
  let written = 0
  for (const fact of facts) {
    const content = fact.content.trim()
    if (content) written += Number(insert.run(novelId, chapterId, content, novelId, chapterId, content).changes)
  }
  return written
}

export function listPendingFacts(db: DatabaseSync, novelId: number): PendingFact[] {
  return db.prepare(
    `SELECT f.id, f.content, f.chapter_id AS chapterId, c.title AS chapterTitle
     FROM fact f LEFT JOIN chapter c ON c.id = f.chapter_id AND c.novel_id = f.novel_id
     WHERE f.novel_id = ? AND f.confirmed = 0 ORDER BY f.id`
  ).all(novelId) as unknown as PendingFact[]
}

export function reviewFact(
  db: DatabaseSync,
  novelId: number,
  factId: number,
  input: FactReviewInput
): 'changed' | 'unchanged' | 'missing' | 'conflict' {
  const sql = input.action === 'confirm'
    ? 'UPDATE fact SET confirmed = 1 WHERE novel_id = ? AND id = ? AND confirmed = 0 AND content = ?'
    : 'DELETE FROM fact WHERE novel_id = ? AND id = ? AND confirmed = 0 AND content = ?'
  if (Number(db.prepare(sql).run(novelId, factId, input.expectedContent).changes) > 0) return 'changed'
  const current = db.prepare('SELECT content, confirmed FROM fact WHERE novel_id = ? AND id = ?')
    .get(novelId, factId) as { content: string; confirmed: number } | undefined
  if (!current) return 'missing'
  if (input.action === 'confirm' && current.confirmed === 1 && current.content === input.expectedContent) {
    return 'unchanged'
  }
  return 'conflict'
}
