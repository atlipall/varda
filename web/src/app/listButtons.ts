import type * as maplibregl from 'maplibre-gl';

/** The buttons of a row in the Tracks and Overlays lists, and fitting a row's shapes in view. */

const EYE_ON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2" opacity=".45"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** A delete button asks "Delete?" and needs a second tap within this time (ms). */
const CONFIRM_MS = 3000;

/** Shows or hides the item called `name`. */
export function eyeButton(name: string, visible: boolean, toggle: () => void): HTMLButtonElement {
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'track-eye';
  eye.setAttribute('aria-pressed', String(visible));
  eye.setAttribute('aria-label', visible ? `Hide ${name}` : `Show ${name}`);
  eye.innerHTML = visible ? EYE_ON : EYE_OFF;
  eye.onclick = toggle;
  return eye;
}

/** A bin that asks "Delete?" and deletes on a second tap. */
export function deleteButton(name: string, remove: () => void): HTMLButtonElement {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'track-delete';
  del.setAttribute('aria-label', `Delete ${name}`);
  del.innerHTML = TRASH;
  let timer = 0;
  del.onclick = () => {
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm');
      del.textContent = 'Delete?';
      timer = window.setTimeout(() => {
        del.classList.remove('confirm');
        del.innerHTML = TRASH;
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    remove();
  };
  return del;
}

/** Fits `bounds` in view, keeping them clear of `panel` while it is open. */
export function fitClearOf(map: maplibregl.Map, panel: HTMLElement, bounds: maplibregl.LngLatBoundsLike, maxZoom: number): void {
  const top = panel.hidden ? 60 : panel.getBoundingClientRect().bottom - map.getContainer().getBoundingClientRect().top + 30;
  const room = map.getContainer().clientHeight - top - 60;
  map.fitBounds(bounds, { padding: { top: room > 120 ? top : 60, bottom: 60, left: 40, right: 40 }, maxZoom, duration: 800 });
}
