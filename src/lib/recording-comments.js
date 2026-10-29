/** Identify the three durable recording filename forms used by Barktown. */
export function recordingType(entry) {
  const filename = entry?.filename ?? '';
  if (/(?:^|\s)-A-(?=\s|\.|$)/i.test(filename)) return 'automatic';
  if (/(?:^|\s)SAMPLE(?=\s|\.|$)/i.test(filename)) return 'sample';
  return 'manual';
}

/** Return true for a whole-recording note under either API field convention. */
export function isSampleWideNote(annotation) {
  const type = annotation?.type ?? annotation?.source;
  const startSec = annotation?.startSec ?? annotation?.start_sec;
  const endSec = annotation?.endSec ?? annotation?.end_sec;
  return type === 'note' && Number(startSec) === 0 && Number(endSec) === 0;
}

/** Whole-recording DB notes attached to a diary entry. */
export function recordingCommentAnnotations(entry) {
  return Array.isArray(entry?.annotations)
    ? entry.annotations.filter(isSampleWideNote)
    : [];
}

/** Filename comment for manual recordings; automatic/sample markers are not comments. */
export function manualFilenameComment(entry) {
  if (recordingType(entry) !== 'manual') return '';

  const filename = entry?.filename ?? '';
  const match = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?:\s+(.+?))?\.(?:m4a|aac|wav|mp3)$/i.exec(filename);
  if (match) return match[1]?.trim() ?? '';
  return typeof entry?.label === 'string' ? entry.label.trim() : '';
}

/**
 * Resolve visible comments with DB notes first. Manual recordings fall back
 * to their filename comment; automatic and SAMPLE markers never do.
 */
export function recordingCommentLabels(entry) {
  const databaseAnnotations = recordingCommentAnnotations(entry);
  const databaseLabels = databaseAnnotations
    .map(annotation => typeof annotation.label === 'string' ? annotation.label.trim() : '')
    .filter(Boolean);
  // An empty persisted note is the durable "comment cleared" marker. Its
  // presence must suppress the immutable filename fallback on old recordings.
  if (databaseAnnotations.length) return databaseLabels;

  const filenameComment = manualFilenameComment(entry);
  return filenameComment ? [filenameComment] : [];
}

/** Compact form used in flags and the playback popup. */
export function recordingComment(entry) {
  return recordingCommentLabels(entry).join(' · ');
}

/**
 * Add sample-wide notes from the legacy bulk annotations response to their
 * copied diary entries. Existing diary-owned annotations are kept intact.
 */
export function inheritSampleWideAnnotations(entries, annotations) {
  const notesBySampleId = new Map();

  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (!isSampleWideNote(annotation)) continue;
    const sampleId = annotation?.sampleId ?? annotation?.sample_id;
    if (!sampleId) continue;
    const notes = notesBySampleId.get(sampleId) ?? [];
    notes.push(annotation);
    notesBySampleId.set(sampleId, notes);
  }

  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (!entry?.sampleId) return entry;

    const existing = Array.isArray(entry.annotations) ? entry.annotations : [];
    const inherited = notesBySampleId.get(entry.sampleId) ?? [];
    const merged = [...existing];

    for (const annotation of inherited) {
      const duplicate = merged.some((current) => (
        current?.id === annotation?.id
        && (current?.sampleId ?? current?.sample_id) === entry.sampleId
      ));
      if (!duplicate) merged.push(annotation);
    }

    return { ...entry, annotations: merged };
  });
}

/**
 * Older public APIs expose sample links but not an annotations array on diary
 * entries. Refresh individual diary entries for that compatibility case;
 * the bulk training annotation feed is private.
 */
export async function hydrateRecordingCommentAnnotations(entries, publicApiBase, fetchImpl = fetch) {
  const needsFallback = Array.isArray(entries) && entries.some((entry) => (
    entry?.sampleId && !Array.isArray(entry.annotations)
  ));
  if (!needsFallback) return entries;

  return Promise.all(entries.map(async (entry) => {
    if (!entry?.sampleId || Array.isArray(entry.annotations)) return entry;
    const response = await fetchImpl(`${publicApiBase}/api/diary/${encodeURIComponent(entry.id)}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const current = await response.json();
    return { ...entry, annotations: Array.isArray(current.annotations) ? current.annotations : [] };
  }));
}

/** Replace an entry's normalized whole-recording annotation snapshot. */
export function withRecordingCommentAnnotations(entry, annotations) {
  return {
    ...entry,
    annotations: Array.isArray(annotations) ? annotations : [],
  };
}
