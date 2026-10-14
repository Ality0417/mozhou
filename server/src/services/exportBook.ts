import type { DatabaseSync } from 'node:sqlite'
import { chapterHeading, type WritingProfile } from '../../../shared/src/writingProfile'
import { getNovelWritingProfile } from './writingProfile'
export interface ExportBook { title: string; inspiration: string; profile: WritingProfile; chapters: Array<{ title: string; content: string }> }
export function getExportBook(db: DatabaseSync, novelId: number): ExportBook | null {
  const novel = db.prepare('SELECT title, inspiration FROM novel WHERE id = ?').get(novelId) as { title: string; inspiration: string } | undefined
  if (!novel) return null
  const profile = getNovelWritingProfile(db, novelId)
  // 灵感是内部创作素材；只有作者明确勾选时才进入导出，旧书也不隐式泄露。
  const chapters = db.prepare(`SELECT c.title,c.content FROM chapter c LEFT JOIN volume v ON v.id=c.volume_id
    WHERE c.novel_id=? AND c.content!='' AND c.status IN ('written','reviewed','done')
    ORDER BY COALESCE(v.order_index,2147483647),c.id`).all(novelId) as Array<{ title: string; content: string }>
  return { title: novel.title || (profile.language === 'en' ? 'Untitled novel' : '未命名小说'), inspiration: profile.export.includeInspiration ? novel.inspiration : '', profile,
    chapters: chapters.map((chapter, index) => ({ title: chapterHeading(chapter.title, index, profile), content: chapter.content.replace(/\r\n?/g, '\n') })) }
}
