/**
 * Pick the fragment that should become selected after `deletedId` is removed.
 * Prefer the following fragment in timeline order; when the deleted fragment
 * was last, keep the workflow open by falling back to the previous fragment.
 */
export function fragmentSelectionAfterDelete(annotations, deletedId) {
  const fragments = annotations
    .filter(annotation => annotation.source !== 'note')
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  const deletedIndex = fragments.findIndex(fragment => fragment.id === deletedId);
  if (deletedIndex === -1) return null;
  return fragments[deletedIndex + 1]?.id ?? fragments[deletedIndex - 1]?.id ?? null;
}

/**
 * Select the adjacent fragment in timeline order, wrapping at both ends.
 * With no current selection, forward starts at the first fragment and
 * backward starts at the last.
 */
export function adjacentFragmentSelectionId(annotations, selectedId, delta) {
  const fragments = annotations
    .filter(annotation => annotation.source !== 'note')
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  if (!fragments.length || delta === 0) return null;
  const selectedIndex = fragments.findIndex(fragment => fragment.id === selectedId);
  if (selectedIndex === -1) {
    return (delta > 0 ? fragments[0] : fragments[fragments.length - 1]).id;
  }
  const nextIndex = (selectedIndex + (delta > 0 ? 1 : -1) + fragments.length) % fragments.length;
  return fragments[nextIndex].id;
}
