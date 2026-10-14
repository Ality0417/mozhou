import type { PendingData } from './types'
import { PendingFactList, type FactReviewProps } from './PendingFactList'

export function PendingPanel({ pending, onClose, factBusy, onReviewFact }: FactReviewProps & {
  pending: PendingData | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="panel" style={{ marginTop: 12, background: 'var(--bg-card)' }}>
      <div className="row justify-between">
        <strong>待确认区</strong>
        <button onClick={onClose} style={{ fontSize: 12, padding: '2px 6px' }}>关闭</button>
      </div>
      {pending && pending.pendingFacts.length > 0 && (
        <PendingFactList facts={pending.pendingFacts} factBusy={factBusy} onReviewFact={onReviewFact} />
      )}
      {pending && pending.pendingCharacters.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <span className="muted">待确认角色：</span>
          {pending.pendingCharacters.map((character) => <div key={character.id}>• {character.name}</div>)}
        </div>
      )}
      {pending && pending.pendingFacts.length === 0 && pending.pendingCharacters.length === 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>暂无待确认项</p>
      )}
    </div>
  )
}
