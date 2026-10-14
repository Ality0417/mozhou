import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { Server } from 'node:http'
import { applyMigrations } from '../server/src/db/migrate'
import { seedIfEmpty } from '../server/src/db/seed'
import { createWritingProfileRouter } from '../server/src/routes/writingProfile'
import { createExportRouter } from '../server/src/routes/export'
import { apiErrorMiddleware } from '../server/src/services/apiError'
import { getNovelWritingProfile, countNovelWords, withProjectLanguage } from '../server/src/services/writingProfile'
import { buildFrozenContext } from '../server/src/services/context/frozen'
import { getNovelWritingRules } from '../server/src/services/guidance'
import { defaultWritingProfile, countWritingUnits, formatPlainText, writingProfileSchema } from '../shared/src/writingProfile'
import { getExportBook } from '../server/src/services/exportBook'
import { claimChapter } from '../server/src/services/chapterGeneration/state'
import { persistGeneratedChapter } from '../server/src/services/chapterGeneration/persistence'
import { writingFixtures } from './fixtures/novel-workbench'

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true, timeout: 5000 }); applyMigrations(db); seedIfEmpty(db) })
afterEach(() => db.close())
function novel(): number { return Number(db.prepare("INSERT INTO novel(title,inspiration) VALUES ('Local draft','private planning note')").run().lastInsertRowid) }
function saveProfile(id: number, language: 'zh-CN' | 'en') { const profile = defaultWritingProfile(language); db.prepare('UPDATE novel SET writing_profile_json=? WHERE id=?').run(JSON.stringify(profile), id); return profile }
async function serve(run: (url: string) => Promise<void>) {
  const app = express(); app.use(express.json()); app.use('/api/novels', createWritingProfileRouter(db)); app.use('/api/novels', createExportRouter(db)); app.use(apiErrorMiddleware)
  const server: Server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)) })
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/novels`) }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
describe('project writing profile contracts', () => {
  it('preserves inherited language and isolates novels', () => {
    const a = novel(), b = novel(); db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('lang','traditional')").run()
    expect(getNovelWritingProfile(db, a).language).toBe('zh-TW'); saveProfile(a, 'en')
    expect(getNovelWritingProfile(db, a).language).toBe('en'); expect(getNovelWritingProfile(db, b).language).toBe('zh-TW')
    expect(getNovelWritingRules(db, a)).not.toContain('全文统一使用繁体中文')
  })
  it('validates language and bounded editorial inputs', () => {
    expect(writingProfileSchema.safeParse({ ...defaultWritingProfile(), language: 'xx' }).success).toBe(false)
    expect(writingProfileSchema.safeParse({ ...defaultWritingProfile(), targetChapterLength: 12001 }).success).toBe(false)
    expect(writingProfileSchema.safeParse({ ...defaultWritingProfile(), notes: 'x'.repeat(1201) }).success).toBe(false)
  })
  it('versions frozen context hash with project settings', () => {
    const id = novel(), first = buildFrozenContext(db, id).hash; saveProfile(id, 'en'); const next = buildFrozenContext(db, id)
    expect(next.hash).not.toBe(first); expect(next.writingRules).toContain('Project output language: English'); expect(next.hash).toBe(buildFrozenContext(db, id).hash)
  })
  it('covers direct model paths without rewriting schema or evidence', () => {
    const id = novel(); saveProfile(id, 'en'); const messages = [{ role: 'user' as const, content: 'JSON {"title":"..."}，证据「线索」' }]
    const output = withProjectLanguage(db, id, messages)
    expect(output[0].role).toBe('system'); expect(output[0].content).toContain('quoted evidence'); expect(output[1]).toEqual(messages[0]); expect(messages).toHaveLength(1)
    expect(withProjectLanguage(db, id, output)).toEqual(output); expect(withProjectLanguage(db, null, messages)).toBe(messages)
  })
  it('persists via HTTP and recounts current content without rewriting attribution', async () => {
    const id = novel(); const chapter = Number(db.prepare("INSERT INTO chapter(novel_id,content,word_count,ai_words,human_words) VALUES (?,'A new story begins',0,7,3)").run(id).lastInsertRowid)
    await serve(async base => {
      const path = `${base}/${id}/writing-profile`, put = (url: string, profile: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) })
      expect((await (await fetch(path)).json()).inherited).toBe(true); expect((await put(path, defaultWritingProfile('en'))).status).toBe(200)
      expect((await (await fetch(path)).json()).profile.language).toBe('en')
      expect(db.prepare('SELECT word_count,ai_words,human_words FROM chapter WHERE id=?').get(chapter)).toEqual({ word_count: 4, ai_words: 7, human_words: 3 })
      expect((await put(path, { ...defaultWritingProfile(), language: 'xx' })).status).toBe(400)
      expect((await put(`${base}/99999/writing-profile`, defaultWritingProfile())).status).toBe(404)
      expect((await fetch(`${base}/99999/writing-profile`)).status).toBe(404)
    })
  })
  it('does not leak legacy inspiration without explicit opt-in', async () => {
    const id = novel(); expect(getExportBook(db, id)?.inspiration).toBe('')
    await serve(async base => {
      expect((await (await fetch(`${base}/${id}/export-preview`)).json()).inspiration).toBe('')
      for (const format of ['txt','md']) expect(await (await fetch(`${base}/${id}/export?format=${format}`)).text()).not.toContain('private planning note')
    })
    const profile = saveProfile(id, 'en'); profile.export.includeInspiration = true
    db.prepare('UPDATE novel SET writing_profile_json=? WHERE id=?').run(JSON.stringify(profile), id)
    expect(getExportBook(db, id)?.inspiration).toBe('private planning note')
  })
  it('counts words instead of zero and preserves Chinese semantics', () => {
    expect(countWritingUnits("Mara's well-lit lamp couldn't fall.", 'en')).toBe(5)
    expect(countWritingUnits('林禾打开门。123 ABC', 'zh-CN')).toBe(5); expect(countWritingUnits(' --- 😀', 'en')).toBe(0)
  })
  it.each(writingFixtures)('original offline $id: claim → persist → preview → export', async fixture => {
    const id = novel(), profile = saveProfile(id, fixture.language)
    profile.export = { heading: 'numbered', utf8Bom: false, lineEnding: 'crlf', includeInspiration: false }
    db.prepare('UPDATE novel SET title=?,inspiration=?,writing_profile_json=? WHERE id=?').run(fixture.title, fixture.inspiration, JSON.stringify(profile), id)
    const chapter = Number(db.prepare('INSERT INTO chapter(novel_id,title) VALUES (?,?)').run(id, fixture.chapterTitle).lastInsertRowid)
    const persisted = persistGeneratedChapter(db, claimChapter(db,id,chapter), { content: fixture.content, aborted: false })
    expect(persisted.persisted).toBe(true); expect(persisted.wordCount).toBeGreaterThan(100); expect(countNovelWords(db,id,fixture.content)).toBe(persisted.wordCount)
    await serve(async base => {
      const preview = await (await fetch(`${base}/${id}/export-preview`)).json(); expect(preview.inspiration).toBe(''); expect(preview.chapters[0].title).toContain(fixture.language === 'en' ? 'Chapter 1' : '第 1 章')
      const txt = Buffer.from(await (await fetch(`${base}/${id}/export?format=txt`)).arrayBuffer()); expect(txt.subarray(0,3).equals(Buffer.from([239,187,191]))).toBe(false); expect(txt.toString()).toContain('\r\n'); expect(txt.toString()).not.toContain(fixture.inspiration)
      const md = await (await fetch(`${base}/${id}/export?format=md`)).text(); expect(md).toContain(`## ${preview.chapters[0].title}`); expect(md).toContain(fixture.content)
      for (const format of ['docx','epub']) { const response = await fetch(`${base}/${id}/export?format=${format}`); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer()).subarray(0,2).toString()).toBe('PK') }
    })
  })
  it('orders chapter exports by volume', () => {
    const id = novel(); saveProfile(id,'en')
    const later = Number(db.prepare("INSERT INTO volume(novel_id,title,order_index) VALUES (?,'Later',2)").run(id).lastInsertRowid), early = Number(db.prepare("INSERT INTO volume(novel_id,title,order_index) VALUES (?,'Earlier',1)").run(id).lastInsertRowid)
    for (const [volume,title] of [[later,'Second'],[early,'First']] as const) db.prepare("INSERT INTO chapter(novel_id,volume_id,title,content,status) VALUES (?,?,?,'Written text','written')").run(id,volume,title)
    expect(getExportBook(db,id)?.chapters.map(value=>value.title)).toEqual(['First','Second']); expect(getExportBook(db,99999)).toBeNull()
  })
  it('normalizes newlines and optional BOM exactly once', () => {
    const profile = defaultWritingProfile('en'); profile.export.lineEnding='crlf'
    const text = formatPlainText('A','',[{ title:'One',content:'a\r\nb\rc\nd' }],profile)
    expect(text.startsWith('\uFEFF')).toBe(true); expect(text).not.toContain('\r\r'); expect(text).toContain('a\r\nb\r\nc\r\nd')
  })
})
