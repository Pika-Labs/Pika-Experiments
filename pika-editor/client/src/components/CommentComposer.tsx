import { useEffect, useRef, useState } from 'react';
import { useEscapeKey } from '../useEscapeKey';
import * as api from '../api';

interface Props {
  at: number;
  clipId?: string;
  trackId?: string;
  ghostClipId?: string | null;
  /** Screen coords of the click — composer pins here via position:fixed so it escapes lane-content overflow clipping. */
  screenX: number;
  screenY: number;
  onClose: () => void;
}

export function CommentComposer({ at, clipId, trackId, ghostClipId, screenX, screenY, onClose }: Props) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);
  useEscapeKey(true, onClose);

  async function save() {
    if (!note.trim()) return;
    setSaving(true);
    try {
      await api.addComment({ at, clipId, trackId, note: note.trim(), ghostClipId });
      onClose();
    } finally { setSaving(false); }
  }

  // position:fixed so the popover escapes the lane-content overflow:hidden
  // that was clipping the body + Generate button.
  const left = Math.max(12, Math.min(window.innerWidth - 292, screenX));
  const top = Math.max(12, Math.min(window.innerHeight - 200, screenY + 12));

  return (
    <div
      className="cmt-composer fixed-composer"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cmt-composer-head">
        {clipId ? 'Comment on clip' : ghostClipId ? 'Describe this scene' : 'Note to agent'}
      </div>
      <textarea
        ref={ref}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder={ghostClipId
          ? 'e.g. 5s slow push-in on Cami at the window, dawn light…'
          : clipId
            ? 'e.g. regenerate brighter, less shaky'
            : 'e.g. the second act drags, cut it down'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="cmt-composer-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={saving || !note.trim()} onClick={save}>
          {saving ? 'Saving…' : 'Save · ⌘⏎'}
        </button>
      </div>
    </div>
  );
}
