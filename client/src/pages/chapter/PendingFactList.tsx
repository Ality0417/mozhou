import type { FactReviewInput, PendingFact } from '../../types'

export interface FactReviewProps {
  factBusy?: boolean
  onReviewFact?: (fact: PendingFact, action: FactReviewInput['action']) => void
}

export function PendingFactList({ facts, factBusy = false, onReviewFact }: FactReviewProps & {
  facts: PendingFact[]
}): React.JSX.Element {
  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <span className="muted">待确认事实（{facts.length}）：</span>
      <p className="muted" style={{ margin: '4px 0' }}>AI 提取可能有误，核对后逐条确认；未确认内容不会作为已确认事实约束后续写作。</p>
      {facts.map((fact) => (
        <div key={fact.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div>• {fact.content}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            来源：{fact.chapterTitle || (fact.chapterId ? `章节 #${fact.chapterId}` : '未关联章节')}
          </div>
          {onReviewFact && (
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button className="sm primary" disabled={factBusy} onClick={() => onReviewFact(fact, 'confirm')}>确认事实入账</button>
              <button className="sm" disabled={factBusy} onClick={() => onReviewFact(fact, 'reject')}>拒绝</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
