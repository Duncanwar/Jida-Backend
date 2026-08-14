import { ReviewRating, ReviewRecommendation, type Review } from "@prisma/client";
import { z } from "zod";

/**
 * The JIDA Manuscript Review Form (Volume 7, Issue 2, 2026).
 *
 * The form has four parts, and they differ in who may read them:
 *
 *   1. Assessment of the article  — seven rated items   → reviewer + editor
 *   2. Overall Recommendation                            → reviewer + editor
 *   3. Comments and Suggestions to the Author(s)         → reviewer + editor + AUTHOR
 *   4. Confidential Comments                             → reviewer + editor only
 *
 * Part 4 is captioned "any comments in this section will not be shown to the
 * authors" on the form, and part 1's ratings are not author-facing either. That
 * split is enforced here, in one place, by two serializers — so no route can
 * leak a section by picking the wrong fields.
 */

/** The seven rated items, in the order they appear on the form. */
export const ASSESSMENT_ITEMS = [
  { key: "ratingTitle", label: "The title is specific and reflects the main ideas of the article." },
  { key: "ratingAbstract", label: "The abstract clearly presents objects, methods and results." },
  {
    key: "ratingLiterature",
    label: "The literature review and significance of the article are explained clearly.",
  },
  { key: "ratingMethods", label: "The research study methods are sound and appropriate." },
  {
    key: "ratingConclusions",
    label: "The conclusions or summary are accurate and supported by the content.",
  },
  { key: "ratingReferences", label: "References are up-dated, adequate and correctly cited." },
  { key: "ratingStructure", label: "The structure is compact, sequential and logical." },
] as const;

export type AssessmentKey = (typeof ASSESSMENT_ITEMS)[number]["key"];

/** The form's four recommendation levels, mapped onto the stored enum. */
export const RECOMMENDATION_LABELS: Record<ReviewRecommendation, string> = {
  [ReviewRecommendation.ACCEPT]: "Accepted, no revision needed.",
  [ReviewRecommendation.MINOR_REVISION]: "Accepted, minor revisions needed.",
  [ReviewRecommendation.MAJOR_REVISION]: "Return for major revision and resubmission",
  [ReviewRecommendation.REJECT]: "Reject",
};

const ratingsShape = Object.fromEntries(
  ASSESSMENT_ITEMS.map((item) => [item.key, z.nativeEnum(ReviewRating)]),
) as Record<AssessmentKey, z.ZodNativeEnum<typeof ReviewRating>>;

/** Validates a submitted review form. */
export const reviewFormSchema = z.object({
  ...ratingsShape,
  recommendation: z.nativeEnum(ReviewRecommendation),
  /** "Overall evaluation of the manuscript briefly (100-200 words)". */
  commentsToAuthor: z.string().min(1, "An overall evaluation is required"),
  /** "Reasons for acceptance or rejection ... suggestions for revisions". */
  specificSuggestions: z.string().optional(),
  /** "Confidential Comments (if any)" — optional, per the form. */
  commentsToEditor: z.string().optional(),
});

export type ReviewFormInput = z.infer<typeof reviewFormSchema>;

/** Everything on the form. For the reviewer who wrote it and for editors. */
export function toFullReview(review: Review) {
  return {
    id: review.id,
    recommendation: review.recommendation,
    recommendationLabel: RECOMMENDATION_LABELS[review.recommendation],
    assessment: ASSESSMENT_ITEMS.map((item) => ({
      key: item.key,
      label: item.label,
      rating: review[item.key],
    })),
    commentsToAuthor: review.commentsToAuthor,
    specificSuggestions: review.specificSuggestions,
    commentsToEditor: review.commentsToEditor,
    hasAttachment: Boolean(review.attachmentStoredName),
    attachmentName: review.attachmentOriginalName,
    createdAt: review.createdAt,
  };
}

/**
 * Only "Comments and Suggestions to the Author(s)".
 *
 * Deliberately omits the ratings, the recommendation and the confidential
 * comments: an author must not learn how a reviewer scored them, nor read
 * notes the form promises are editor-only.
 */
export function toAuthorVisibleReview(review: Review) {
  return {
    id: review.id,
    commentsToAuthor: review.commentsToAuthor,
    specificSuggestions: review.specificSuggestions,
    createdAt: review.createdAt,
  };
}
