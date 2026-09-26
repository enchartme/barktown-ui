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
