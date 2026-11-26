/** Explanations copied from barktown-utils/docs/training-data.md. */
export const TRAINING_COLOR_GUIDES = Object.freeze({
  label: Object.freeze({
    column: 'label',
    title: 'Label',
    plain: 'The human-assigned sound label, such as bark or wind.',
    detailed: 'The multiclass folder/manifest label attached to the whole source fragment. Every window inherits it, which is precisely why boundary windows and mixed-content fragments deserve inspection for label noise.',
  }),
  classifierScore: Object.freeze({
    column: 'classifier_score',
    title: 'Classifier score',
    plain: 'How strongly the current model thinks this is a wanted dog sound.',
    detailed: "The TFLite model's sigmoid output interpreted as the probability-like score for the positive bark/yap class. It ranges from 0 to 1 and is empty only when --no-classifier is used.",
  }),
  classifierError: Object.freeze({
    column: 'classifier_error',
    title: 'Classifier error',
    plain: 'How badly the current model disagrees with the human label.',
    detailed: 'A label-relative model error defined as 1 - score for a positive row and score for a negative row. Values near 1 indicate confident disagreement between model and assigned binary label; this is useful for review but does not prove that the human label is wrong.',
  }),
  knnLabelDisagreement: Object.freeze({
    column: 'knn_label_disagreement',
    title: 'KNN label mismatch',
    plain: 'How many nearby sounds have a different label.',
    detailed: 'The fraction from 0 to 1 of the nearest neighbours from other original recordings whose detailed label differs from this row. A high value marks a local embedding neighbourhood inconsistent with the multiclass annotation.',
  }),
  knnBinaryDisagreement: Object.freeze({
    column: 'knn_binary_disagreement',
    title: 'KNN binary mismatch',
    plain: 'How many nearby sounds disagree about dog sound versus other sound.',
    detailed: "The same cross-recording neighbour calculation after collapsing labels to positive dog sound versus negative other sound. This is more directly aligned with the deployed classifier's decision task than knn_label_disagreement.",
  }),
  knnMeanDistance: Object.freeze({
    column: 'knn_mean_distance',
    title: 'KNN mean distance',
    plain: 'How isolated this sound is from its nearest sounds in other recordings.',
    detailed: 'The mean cosine distance to the selected nearest neighbours in the 50-dimensional PCA working space. Larger values mean lower local density or greater isolation, but the scale depends on the corpus and should be compared within this export rather than against a universal cutoff.',
  }),
  labelCentroidDistance: Object.freeze({
    column: 'label_centroid_distance',
    title: 'Centroid distance',
    plain: 'How unusual this sound is compared with the typical sound carrying its label.',
    detailed: 'The cosine distance from this row to the normalized centroid of all rows carrying the same detailed label in PCA space. It is a simple class-conditional outlier measure and can be large for either a bad annotation or a rare but valid example.',
  }),
  nearestDistance: Object.freeze({
    column: 'nearest_distance',
    title: 'Nearest distance',
    plain: 'How different this sound is from that most similar sound.',
    detailed: 'The cosine distance to the nearest embedding from another recording session in PCA space. Values closer to zero represent more similar embeddings, while larger values represent less similar embeddings; negative numerical noise is not expected but tiny floating-point effects should not be overinterpreted.',
  }),
  suspicionScore: Object.freeze({
    column: 'suspicion_score',
    title: 'Suspicion score',
    plain: 'A combined 0-to-1 priority score for manual review; higher is more suspicious.',
    detailed: 'The mean of local-isolation percentile, within-label centroid-distance percentile, and detailed-label neighbour disagreement, plus classifier_error when classifier scoring is enabled. It is a heuristic review priority rather than a calibrated probability of a bad sample.',
  }),
  suspicionRank: Object.freeze({
    column: 'suspicion_rank',
    title: 'Suspicion rank',
    plain: 'The suggested listening order, with 1 being the first item to inspect.',
    detailed: 'A one-based ordering produced by sorting suspicion_score from highest to lowest. Rank is often easier to use for a listening queue than choosing an arbitrary numeric score threshold.',
  }),
});

export const TRAINING_COLOR_ENCODINGS = Object.freeze(
  Object.entries(TRAINING_COLOR_GUIDES).map(([value, guide]) => Object.freeze({
    value,
    label: guide.title,
  })),
);
