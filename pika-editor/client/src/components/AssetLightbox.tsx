/**
 * Shared asset preview lightbox — used by History, Library, and the
 * Workspace tiles. Click backdrop OR press Esc to close. Image fits to
 * 75vh; video gets controls + autoplay; audio gets a controls strip.
 *
 * The component intentionally takes a `preview` object instead of a list
 * of items — we don't have prev/next navigation between assets, just
 * "open this one." Keeping the API minimal so any tile can hand it the
 * three fields it already has.
 */
import { useEffect } from 'react';
import { assetUrl } from '../store';

export interface AssetPreview {
  rel: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  name: string;
}

export function AssetLightbox({ preview, onClose }: { preview: AssetPreview; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const src = assetUrl(preview.rel);

  return (
    <div className="render-modal-backdrop" onClick={onClose}>
      <div className="workspace-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="render-modal-head">
          <div>
            <div className="render-modal-title">{preview.name}</div>
            <div className="render-modal-sub">{preview.rel}</div>
          </div>
          <button className="render-modal-close" onClick={onClose}>×</button>
        </div>
        {preview.kind === 'image' && (
          <img
            src={src} alt={preview.name}
            style={{ maxWidth: '100%', maxHeight: '75vh', display: 'block', margin: '0 auto', borderRadius: 'var(--r-md)' }}
          />
        )}
        {preview.kind === 'video' && (
          <video
            src={src} controls autoPlay
            style={{ width: '100%', maxHeight: '75vh', borderRadius: 'var(--r-md)', background: '#000', display: 'block' }}
          />
        )}
        {preview.kind === 'audio' && (
          <audio src={src} controls autoPlay style={{ width: '100%' }} />
        )}
        {preview.kind === 'other' && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)', fontSize: 12 }}>
            Preview not available for this file type.
          </div>
        )}
      </div>
    </div>
  );
}
