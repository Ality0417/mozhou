import type { DatabaseSync } from 'node:sqlite'
import { countWritingUnits, defaultWritingProfile, writingProfileSchema, type WritingProfile } from '../../../shared/src/writingProfile'
import type { LlmMessage } from './llm/types'
export const PROFILE_MARKER = '【项目语言与投稿档案】'
export function getSavedWritingProfile(db: DatabaseSync, novelId: number): WritingProfile | null {
  const row = db.prepare('SELECT writing_profile_json FROM novel WHERE id = ?').get(novelId) as { writing_profile_json: string | null } | undefined
  if (!row?.writing_profile_json) return null
  try { const result = writingProfileSchema.safeParse(JSON.parse(row.writing_profile_json)); return result.success ? result.data : null } catch { return null }
}
export function getNovelWritingProfile(db: DatabaseSync, novelId: number): WritingProfile {
  const saved = getSavedWritingProfile(db, novelId)
  if (saved) return saved
  const global = db.prepare("SELECT value FROM app_settings WHERE key = 'lang'").get() as { value: string } | undefined
  return defaultWritingProfile(global?.value === 'traditional' ? 'zh-TW' : 'zh-CN')
}
export function countNovelWords(db: DatabaseSync, novelId: number, content: string): number { return countWritingUnits(content, getNovelWritingProfile(db, novelId).language) }
export function buildProfileRules(profile: WritingProfile): string {
  const language = profile.language === 'en' ? 'English' : profile.language === 'zh-TW' ? 'Traditional Chinese (繁體中文)' : 'Simplified Chinese (简体中文)'
  const mode = profile.preset === 'serial' ? 'Each chapter advances a concrete conflict and ends at a meaningful turning point. Avoid repetitive recap or artificial cliffhangers.' : profile.preset === 'manuscript' ? 'Use cohesive book-length pacing and clean chapter transitions. Do not add author notes or platform calls to action.' : 'Use the story plan and genre to determine pacing; do not assume a particular platform formula.'
  return [PROFILE_MARKER,
    `Project output language: ${language}. Write story prose, titles, plans and human-readable review explanations in this language, even when surrounding workflow instructions are Chinese. This project language overrides application-wide language defaults.`,
    'Keep JSON keys, required enum values, identifiers, quoted evidence and established proper names unchanged. Do not translate evidence quotations.',
    `For a full prose chapter, aim for approximately ${profile.targetChapterLength} ${profile.language === 'en' ? 'English words' : 'Chinese characters'}; this target does not apply to outlines, JSON metadata, reviews or excerpts.`, mode,
    profile.market ? `Target readership/market (author supplied, not a legal or platform rule): ${JSON.stringify(profile.market)}.` : '',
    profile.notes ? `Author editorial preferences: ${JSON.stringify(profile.notes)}.` : '',
    'These are generic editorial preferences, not verified platform submission, AI-disclosure or copyright policies.'
  ].filter(Boolean).join('\n')
}
export function withProjectLanguage(db: DatabaseSync, novelId: number | null | undefined, messages: LlmMessage[]): LlmMessage[] {
  if (!novelId) return messages
  const profile = getSavedWritingProfile(db, novelId)
  if (!profile) return messages
  const rules = buildProfileRules(profile)
  if (messages.some(message => message.role === 'system' && message.content?.includes(rules))) return messages
  return [{ role: 'system', content: rules }, ...messages]
}
