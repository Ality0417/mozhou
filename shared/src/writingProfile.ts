import { z } from 'zod'

export const writingLanguages = ['zh-CN', 'zh-TW', 'en'] as const
export type WritingLanguage = (typeof writingLanguages)[number]
export const writingProfileSchema = z.object({
  language: z.enum(writingLanguages),
  market: z.string().trim().max(80),
  preset: z.enum(['general', 'serial', 'manuscript']),
  targetChapterLength: z.number().int().min(300).max(12000),
  notes: z.string().trim().max(1200),
  export: z.object({ heading: z.enum(['original', 'numbered']), lineEnding: z.enum(['lf', 'crlf']), utf8Bom: z.boolean(), includeInspiration: z.boolean() })
})
export type WritingProfile = z.infer<typeof writingProfileSchema>
export const LANGUAGE_LABELS: Record<WritingLanguage, string> = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English' }
export const PROFILE_LABELS: Record<WritingProfile['preset'], string> = { general: '通用创作', serial: '连载章节', manuscript: '完整书稿' }
export function defaultWritingProfile(language: WritingLanguage = 'zh-CN'): WritingProfile {
  return { language, market: '', preset: 'general', targetChapterLength: language === 'en' ? 1800 : 2500, notes: '', export: { heading: 'original', lineEnding: 'lf', utf8Bom: true, includeInspiration: false } }
}
/** 本地统计口径，不是平台官方计数算法。 */
export function countWritingUnits(content: string, language: WritingLanguage): number {
  if (language !== 'en') return (content.match(/[\u4e00-\u9fff]/g) ?? []).length
  return (content.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length
}
export function chapterHeading(title: string, index: number, profile: WritingProfile): string {
  const number = profile.language === 'en' ? `Chapter ${index + 1}` : `第 ${index + 1} 章`
  if (profile.export.heading === 'original') return title.trim() || number
  return title.trim() ? `${number}: ${title.trim()}` : number
}
export function formatPlainText(title: string, inspiration: string, chapters: Array<{ title: string; content: string }>, profile: WritingProfile): string {
  const parts = [title, '']
  if (profile.export.includeInspiration && inspiration) parts.push(inspiration, '')
  for (const chapter of chapters) parts.push(chapter.title, '', chapter.content, '')
  const text = parts.join('\n').replace(/\r\n?/g, '\n')
  return (profile.export.utf8Bom ? '\uFEFF' : '') + (profile.export.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text)
}
