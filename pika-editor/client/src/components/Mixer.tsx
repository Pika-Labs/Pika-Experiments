/**
 * Track mixer — dynamic vertical-slider strip with one channel per audio
 * track (A1, A2, …). Each slider sets the track's gain in dB live on the
 * Web Audio engine AND persists it into timeline.json so playback after
 * reload uses the same mix.
 *
 * Lane labels come from track.label when the user has named it, else fall
 * back to the canonical "A{index+1}". Per-clip gain is separate — see the
 * floating ClipGainPopover.
 */
import { useState } from 'react';
import { useStore } from '../store';
import { audio } from '../audio';

const RANGE_MIN_DB = -40;
const RANGE_MAX_DB = +6;

export function Mixer() {
  const timeline = useStore((s) => s.timeline);
  const setTrackGain = useStore((s) => s.setAudioTrackGain);
  const addAudioTrack = useStore((s) => s.addAudioTrack);
  const [open, setOpen] = useState(false);

  if (!timeline) return null;
  const tracks = timeline.audioTracks ?? [];

  return (
    <div className={`mixer ${open ? 'mixer-open' : ''}`}>
      <button className="mixer-tab" onClick={() => setOpen(!open)} data-tip-below="" data-tip="Mixer · track volumes">
        <span className="mixer-tab-icon">▼</span>
        <span className="mixer-tab-label">Mixer</span>
      </button>
      {open && (
        <div className="mixer-panel">
          {tracks.map((t, idx) => {
            const label = t.label && t.label.trim() ? t.label : `A${idx + 1}`;
            const db = t.gain ?? 0;
            return (
              <div key={t.id} className="mixer-channel" title={`${label} — track ${t.id}`}>
                <input
                  type="range"
                  className="mixer-slider"
                  min={RANGE_MIN_DB} max={RANGE_MAX_DB} step={0.5}
                  value={db}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setTrackGain(t.id, v);
                    audio.setTrackGainDb(t.id, v);
                  }}
                  onDoubleClick={() => {
                    setTrackGain(t.id, 0);
                    audio.setTrackGainDb(t.id, 0);
                  }}
                />
                <div className="mixer-value">{db === 0 ? '0' : (db > 0 ? '+' : '') + db.toFixed(1)}<span className="mixer-unit">dB</span></div>
                <div className="mixer-label">{label}</div>
              </div>
            );
          })}
          <button
            className="mixer-add"
            onClick={() => addAudioTrack()}
            title="Add a new empty audio track"
          >+</button>
        </div>
      )}
    </div>
  );
}
