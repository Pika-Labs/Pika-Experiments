import { useEffect, useRef } from 'react';

interface Props {
  outRel: string;                  // path under <project>/renders, e.g. "jobs/r_xxx.mp4"
  savedTo?: string | null;         // absolute path the file was copied to (user's chosen folder)
  onClose: () => void;
}

async function revealInFinder(args: { rel?: string; abs?: string }) {
  await fetch('/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function RenderResultModal({ outRel, savedTo, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const src = `/renders/${outRel.replace(/^renders\//, '')}`;
  const revealTarget = savedTo
    ? { abs: savedTo }
    : { rel: `renders/${outRel}` };

  return (
    <div className="render-modal-backdrop" onClick={onClose}>
      <div className="render-modal" onClick={(e) => e.stopPropagation()}>
        <div className="render-modal-head">
          <div>
            <div className="render-modal-title">Render complete</div>
            <div className="render-modal-sub">{savedTo ?? outRel}</div>
          </div>
          <button className="render-modal-close" onClick={onClose}>×</button>
        </div>
        <video
          ref={videoRef}
          src={src}
          controls
          autoPlay
          style={{ width: '100%', borderRadius: 'var(--r-md)', background: '#000', display: 'block' }}
        />
        {savedTo && (
          <div className="rm-saved-path" title="Copied to your chosen folder">
            Saved to {savedTo}
          </div>
        )}
        <div className="render-modal-actions">
          <button className="btn secondary" onClick={() => revealInFinder(revealTarget)}>Reveal in Finder</button>
          <a className="btn secondary" href={src} download style={{ textDecoration: 'none' }}>Download</a>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
