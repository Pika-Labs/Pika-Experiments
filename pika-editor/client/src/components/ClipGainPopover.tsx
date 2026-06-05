/**
 * Per-clip gain control. Appears in the timeline header whenever the
 * user has exactly ONE audio clip selected. Slider adjusts that clip's
 * `gain` field in dB; the audio engine reads it on next play().
 *
 * Reads from the UNIFIED audioTracks model (post-refactor). The label
 * pill shows the track the clip is on (whatever the user named it —
 * "MUSIC", "VO", "SFX 2", a custom name) so a clip on track-3 doesn't
 * misleadingly read as "VO" the way the old legacy lane-tag did.
 */
import { useStore } from '../store';

const RANGE_MIN_DB = -40;
const RANGE_MAX_DB = +12;

export function ClipGainPopover() {
  const timeline = useStore((s) => s.timeline);
  const selectedIds = useStore((s) => s.selectedClipIds);
  const setClipGain = useStore((s) => s.setAudioClipGainDb);

  if (!timeline || selectedIds.length !== 1) return null;
  const id = selectedIds[0];

  // Try AUDIO tracks first.
  for (const t of timeline.audioTracks ?? []) {
    const c = t.clips.find((cc) => cc.id === id);
    if (c) {
      const trackLabel = (t.label && t.label.trim()) || t.id.toUpperCase();
      const clipName = (c.prompt && c.prompt.trim())
        || c.src.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/_/g, ' ')
        || c.id;
      const shortName = clipName.length > 24 ? clipName.slice(0, 22) + '…' : clipName;
      const defaultDb = c.kind === 'music' ? 0 : c.kind === 'vo' ? 0 : -3;
      const db = c.gain ?? defaultDb;
      return (
        <GainSlider tag="CLIP" name={shortName} fullName={clipName} on={trackLabel} db={db} defaultDb={defaultDb} setDb={(v) => setClipGain(id, v)} />
      );
    }
  }

  // Fall through to VIDEO clips. Only show the gain control when the V
  // clip has EMBEDDED audio (no linkId — otherwise its audio is on the
  // A-lane and you'd adjust THAT clip's gain instead). The render path
  // and the preview <video> both honor this gain field.
  for (const t of timeline.tracks ?? []) {
    const c = t.clips.find((cc) => cc.id === id);
    if (c) {
      if (c.linkId) return null;   // audio lives on linked A-clip; nothing to adjust here
      const scene = timeline.scenes.find((s) => s.id === c.sceneId);
      const trackLabel = (t.label && t.label.trim()) || t.id.toUpperCase();
      const sceneLabel = (scene?.labels?.[0] ?? c.sceneId) as string;
      const shortName = sceneLabel.length > 24 ? sceneLabel.slice(0, 22) + '…' : sceneLabel;
      const defaultDb = 0;
      const db = c.gain ?? defaultDb;
      return (
        <GainSlider tag="VIDEO" name={shortName} fullName={sceneLabel} on={trackLabel} db={db} defaultDb={defaultDb} setDb={(v) => setClipGain(id, v)} />
      );
    }
  }

  return null;
}

interface GainSliderProps {
  tag: string;
  name: string;
  fullName: string;
  on: string;
  db: number;
  defaultDb: number;
  setDb: (v: number) => void;
}
function GainSlider({ tag, name, fullName, on, db, defaultDb, setDb }: GainSliderProps) {
  return (
    <div className="clip-gain" title={`Per-clip gain — adjusts ONLY this clip ("${fullName}"), not the ${on} track. For the whole track, open the Mixer.`}>
      <span className="clip-gain-tag clip-gain-tag-clip">{tag}</span>
      <span className="clip-gain-clip-name" title={fullName}>{name}</span>
      <span className="clip-gain-track-on">on {on}</span>
      <input
        type="range"
        className="clip-gain-slider"
        min={RANGE_MIN_DB} max={RANGE_MAX_DB} step={0.5}
        value={db}
        onChange={(e) => setDb(Number(e.target.value))}
        onDoubleClick={() => setDb(defaultDb)}
      />
      <span className="clip-gain-value">
        {db === 0 ? '0' : (db > 0 ? '+' : '') + db.toFixed(1)}
        <span className="clip-gain-unit">dB</span>
      </span>
    </div>
  );
}
