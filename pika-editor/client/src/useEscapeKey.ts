import { useEffect } from 'react';

/**
 * Bind window-level Escape → onClose while `active` is true.
 *
 * Why a hook instead of per-component listeners: every modal / popover in
 * the app needs to close on Escape, and a hand-rolled listener per
 * component (a) gets forgotten on some popovers, (b) drifts when refactors
 * move focus around — onKeyDown on a textarea only fires when that
 * textarea is focused, which fails as soon as the user clicks outside the
 * input but still inside the popover. A window listener catches Escape
 * regardless of focus location.
 *
 * Add `useEscapeKey(isOpen, () => setOpen(false))` to any component that
 * mounts a dismissible overlay.
 */
export function useEscapeKey(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, onClose]);
}
