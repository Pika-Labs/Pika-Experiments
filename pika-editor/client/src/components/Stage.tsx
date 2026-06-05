import { useStore } from '../store';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Workspace } from './Workspace';
import { CaptionPanel } from './CaptionPanel';

// Generation status surfaces — workspace tiles bind to live gens via
// taskId and render their own spinner/STUCK state; timeline V1 clips
// read scene.status. We removed the redundant top "live gen" strip —
// per-tile / per-clip surfaces are the single source of truth.

export function Stage() {
  const view = useStore((s) => s.view);
  const selectedCaptionId = useStore((s) => s.selectedCaptionId);
  const captionsPanelOpen = useStore((s) => s.captionsPanelOpen);
  if (view === 'workspace') {
    return (
      <div className="stage stage-workspace">
        <Workspace />
      </div>
    );
  }
  // Timeline view: when a caption row is selected OR the user toggled the
  // captions panel from the CC lane label, the preview row splits into
  // [preview | caption panel]. Preview shrinks; aspect ratio is held by
  // .preview-card so the frame stays correct in the narrower column.
  const showCap = !!selectedCaptionId || captionsPanelOpen;
  return (
    <div className="stage">
      <div className={`stage-preview-row ${showCap ? 'with-cap' : ''}`}>
        <Preview />
        {showCap && <CaptionPanel />}
      </div>
      <Timeline />
    </div>
  );
}
