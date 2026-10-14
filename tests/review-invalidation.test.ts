import { describe, expect, it } from 'vitest'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { applyMigrations } from '../server/src/db/migrate'
import { seedIfEmpty } from '../server/src/db/seed'
import { createVolumesRouter } from '../server/src/routes/volumes'
import { createChapterExecutionRouter } from '../server/src/routes/chapters'
import { apiErrorMiddleware } from '../server/src/services/apiError'
import { claimChapter } from '../server/src/services/chapterGeneration/state'
import { persistGeneratedChapter } from '../server/src/services/chapterGeneration/persistence'

async function fixture(run: (db: DatabaseSync, novel: number, chapter: number, base: string) => Promise<void>) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true, timeout: 5000 }); applyMigrations(db); seedIfEmpty(db)
  const novel = Number(db.prepare("INSERT INTO novel(title) VALUES ('review lifecycle')").run().lastInsertRowid)
  const chapter = Number(db.prepare("INSERT INTO chapter(novel_id,content,status,review_json,fix_history_json) VALUES (?,'原始正文','reviewed','{\"score\":95}','[{\"round\":1}]')").run(novel).lastInsertRowid)
  const app = express(); app.use(express.json()); app.use('/api/novels', createVolumesRouter(db)); app.use('/api/novels', createChapterExecutionRouter(db)); app.use(apiErrorMiddleware)
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/novels/${novel}/chapters/${chapter}`
  try { await run(db,novel,chapter,base) } finally { await new Promise<void>(resolve => server.close(()=>resolve())); db.close() }
}
const row = (db: DatabaseSync, id: number) => db.prepare('SELECT content,status,review_json,fix_history_json FROM chapter WHERE id=?').get(id)
describe('reviews belong to the text they assessed', () => {
  it('invalidates changed text, preserves identical text/delta save and keeps repair budget', async () => {
    await fixture(async (db,_novel,chapter,base) => {
      const patch = (body: unknown) => fetch(base,{ method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) })
      expect((await patch({ content:'原始正文', expectedContent:'原始正文', operationId:randomUUID(), humanWordsDelta:1 })).status).toBe(200)
      expect(row(db,chapter)?.review_json).toBe('{"score":95}')
      expect((await patch({ content:'人工修订正文', expectedContent:'原始正文', operationId:randomUUID(), status:'reviewed' })).status).toBe(200)
      expect(row(db,chapter)).toMatchObject({ content:'人工修订正文',status:'written',review_json:'{}',fix_history_json:'[{"round":1}]' })
    })
  })
  it('invalidates manual review criteria changes', async () => {
    await fixture(async (db,_novel,chapter,base) => {
      expect((await fetch(base,{ method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ goal:{ purpose:'new criteria' } }) })).status).toBe(200)
      expect(row(db,chapter)).toMatchObject({ status:'written',review_json:'{}',fix_history_json:'[{"round":1}]' })
    })
  })
  it.each(['title', 'summary'] as const)('rejects null %s and invalidates an empty field when first given a value', async field => {
    await fixture(async (db,_novel,chapter,base) => {
      expect(() => db.prepare(`UPDATE chapter SET ${field}=NULL WHERE id=?`).run(chapter)).toThrow(/NOT NULL/)
      db.prepare(`UPDATE chapter SET ${field}='' WHERE id=?`).run(chapter)
      const response = await fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: '新内容' }) })
      expect(response.status).toBe(200)
      expect(db.prepare(`SELECT ${field} AS value FROM chapter WHERE id=?`).get(chapter)?.value).toBe('新内容')
      expect(row(db,chapter)).toMatchObject({ content:'原始正文',status:'written',review_json:'{}',fix_history_json:'[{"round":1}]' })
    })
  })
  it('restoring a different snapshot invalidates score and retains repair history', async () => {
    await fixture(async (db,_novel,chapter,base) => {
      const version = db.prepare("INSERT INTO chapter_version(chapter_id,content,note) VALUES (?,'旧版本正文','fixture')").run(chapter).lastInsertRowid
      const response = await fetch(`${base}/versions/${version}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedContent:'原始正文',operationId:randomUUID()})})
      expect(response.status).toBe(200); expect(row(db,chapter)).toMatchObject({ content:'旧版本正文',status:'written',review_json:'{}',fix_history_json:'[{"round":1}]' })
    })
  })
  it.each([undefined,'新标题'])('new generated text invalidates old review with title=%s', async title => {
    await fixture(async (db,novel,chapter) => {
      const claim = claimChapter(db,novel,chapter)
      persistGeneratedChapter(db,claim,{content:'新的生成正文',aborted:false,title})
      expect(row(db,chapter)).toMatchObject({content:'新的生成正文',status:'written',review_json:'{}',fix_history_json:'[{"round":1}]'})
    })
  })
  it.each([
    { title: '新标题', expectedTitle: '新标题', review: '{}' },
    { title: '原标题', expectedTitle: '原标题', review: '{"score":95}' },
    { title: '', expectedTitle: '原标题', review: '{"score":95}' },
    { title: undefined, expectedTitle: '原标题', review: '{"score":95}' }
  ])('same generated body uses effective title change for review invalidation: $title', async ({ title, expectedTitle, review }) => {
    await fixture(async (db,novel,chapter) => {
      db.prepare("UPDATE chapter SET title='原标题' WHERE id=?").run(chapter)
      const claim = claimChapter(db,novel,chapter)
      persistGeneratedChapter(db,claim,{content:'原始正文',aborted:false,title})
      expect(db.prepare('SELECT title FROM chapter WHERE id=?').get(chapter)?.title).toBe(expectedTitle)
      expect(row(db,chapter)).toMatchObject({content:'原始正文',status:'written',review_json:review,fix_history_json:'[{"round":1}]'})
    })
  })
})
