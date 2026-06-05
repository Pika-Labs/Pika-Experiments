import { useState } from 'react';
import { useEscapeKey } from '../useEscapeKey';
import * as api from '../api';

interface Props {
  id: string;
  note: string;
  author: 'user' | 'agent';
  resolved: boolean;
  agentReply: string | null;
  leftPct: number;
  kind: 'clip' | 'floating' | 'ghost';
}

export function CommentMarker({ id, note, author, resolved, agentReply, leftPct, kind }: Props) {
  const [open, setOpen] = useState(false);
  useEscapeKey(open, () => setOpen(false));
  const cls = ['cmt-marker', resolved ? 'resolved' : '', author === 'agent' ? 'agent' : 'user', kind === 'ghost' ? 'ghost' : ''].filter(Boolean).join(' ');
  return (
    <>
      <button
        className={cls}
        style={{ left: `${leftPct}%` }}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={note}
      >
        {resolved ? '✓' : author === 'agent' ? '✦' : '!'}
      </button>
      {open && (
        <div className="cmt-popover" style={{ left: `${Math.max(0, Math.min(85, leftPct))}%` }} onClick={(e) => e.stopPropagation()}>
          <div className="cmt-popover-head">
            <span className="cmt-popover-author">{author === 'agent' ? 'Agent' : 'You'}</span>
            {resolved && <span className="cmt-popover-pill">Resolved</span>}
            <button className="cmt-popover-close" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="cmt-popover-note">{note}</div>
          {agentReply && (
            <div className="cmt-popover-reply">
              <div className="cmt-popover-reply-h">Agent</div>
              {agentReply}
            </div>
          )}
          <div className="cmt-popover-actions">
            <button className="btn secondary" onClick={async () => { await api.deleteComment(id); setOpen(false); }}>Delete</button>
            <button
              className="btn primary"
              onClick={async () => { await api.patchComment(id, { resolved: !resolved }); setOpen(false); }}
            >
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
