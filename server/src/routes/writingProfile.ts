import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { writingProfileSchema, countWritingUnits } from '../../../shared/src/writingProfile'
import { getNovelWritingProfile, getSavedWritingProfile } from '../services/writingProfile'
export function createWritingProfileRouter(db: DatabaseSync): Router {
  const router = Router()
  router.get('/:novelId/writing-profile', (req, res, next) => {
    try {
      const id = Number(req.params.novelId)
      if (!db.prepare('SELECT id FROM novel WHERE id = ?').get(id)) { res.status(404).json({ error: 'novel not found' }); return }
      res.json({ profile: getNovelWritingProfile(db, id), inherited: getSavedWritingProfile(db, id) === null })
    } catch (error) { next(error) }
  })
  router.put('/:novelId/writing-profile', (req, res, next) => {
    try {
      const id = Number(req.params.novelId), profile = writingProfileSchema.parse(req.body)
      if (!db.prepare('SELECT id FROM novel WHERE id = ?').get(id)) { res.status(404).json({ error: 'novel not found' }); return }
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare("UPDATE novel SET writing_profile_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(profile), id)
        const chapters = db.prepare('SELECT id,content FROM chapter WHERE novel_id = ?').all(id) as Array<{ id: number; content: string }>
        const update = db.prepare('UPDATE chapter SET word_count = ? WHERE id = ? AND novel_id = ?')
        for (const chapter of chapters) update.run(countWritingUnits(chapter.content, profile.language), chapter.id, id)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      res.json({ profile, inherited: false })
    } catch (error) { next(error) }
  })
  return router
}
