/**
 * Google Scholar inclusion checks.
 *
 * Scholar only indexes an article when its landing page carries complete,
 * accurate `citation_*` metadata and links to a full-text PDF it can parse.
 * Most of that metadata is assembled from the manuscript and its issue, so a
 * manuscript missing an abstract, keywords, an affiliation or a PDF simply will
 * not be picked up — silently, months later.
 *
 * These checks run before a publication is flagged `scholarReady`, so the
 * editor is told what is missing at the moment they try, rather than
 * discovering it from an index that never updates.
 *
 * Sources: Google Scholar "Inclusion Guidelines for Webmasters" — indexing
 * guidelines and the Highwire Press `citation_*` tag set.
 */

/** JIDA's own house rules, from the Blind Peer Review Manuscript Checklist. */
const MIN_ABSTRACT_CHARS = 250;
const MIN_KEYWORDS = 3;
const MAX_KEYWORDS = 8;
const MIN_REFERENCES = 15;
/** Scholar truncates very long titles; keep well inside its limit. */
const MAX_TITLE_CHARS = 250;

export interface ScholarCheck {
  /** Short identifier, so the UI can key on it. */
  id: string;
  /** What is wrong, phrased as an action the editor can take. */
  message: string;
  /** A blocker stops indexing outright; a warning degrades quality. */
  severity: "blocker" | "warning";
}

export interface ScholarReadiness {
  ready: boolean;
  blockers: ScholarCheck[];
  warnings: ScholarCheck[];
}

export interface ScholarSubject {
  title: string;
  abstract: string;
  keywords: string[];
  references: string | null;
  author: { firstName: string | null; lastName: string | null; affiliation: string | null };
  coAuthors: { fullName: string; affiliation: string | null }[];
  issue: { volume: number; issueNumber: number; year: number } | null;
  /** The latest manuscript file, which becomes `citation_pdf_url`. */
  file: { originalName: string; mimeType: string } | null;
}

function countReferences(references: string | null): number {
  if (!references?.trim()) return 0;
  // Reference lists are pasted as one per line; blank lines don't count.
  return references
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
}

function isPdf(file: { originalName: string; mimeType: string }): boolean {
  return (
    file.mimeType === "application/pdf" || file.originalName.toLowerCase().endsWith(".pdf")
  );
}

/**
 * Evaluates a manuscript against what Google Scholar needs to index it.
 * Blockers make indexing fail; warnings make the record poor but usable.
 */
export function checkScholarReadiness(subject: ScholarSubject): ScholarReadiness {
  const blockers: ScholarCheck[] = [];
  const warnings: ScholarCheck[] = [];

  // ── Title ────────────────────────────────────────────────────────────────
  if (!subject.title?.trim()) {
    blockers.push({
      id: "title",
      severity: "blocker",
      message: "The manuscript has no title, so citation_title cannot be emitted.",
    });
  } else if (subject.title.length > MAX_TITLE_CHARS) {
    warnings.push({
      id: "title-length",
      severity: "warning",
      message: `The title is ${subject.title.length} characters; Scholar may truncate anything over ${MAX_TITLE_CHARS}.`,
    });
  }

  // ── Authors ──────────────────────────────────────────────────────────────
  const leadName = [subject.author.firstName, subject.author.lastName].filter(Boolean).join(" ");
  if (!leadName.trim()) {
    blockers.push({
      id: "author-name",
      severity: "blocker",
      message:
        "The submitting author has no first or last name on their account — Scholar needs a real name in citation_author, not an email address.",
    });
  }
  if (!subject.author.affiliation?.trim()) {
    warnings.push({
      id: "author-affiliation",
      severity: "warning",
      message:
        "The submitting author has no affiliation. Scholar uses it to disambiguate authors, and the JIDA checklist requires “Department/Faculty, University/Institute, City, Country”.",
    });
  }
  const namelessCoAuthor = subject.coAuthors.find((c) => !c.fullName?.trim());
  if (namelessCoAuthor) {
    blockers.push({
      id: "coauthor-name",
      severity: "blocker",
      message: "A co-author has no name; every author needs their own citation_author tag.",
    });
  }

  // ── Abstract ─────────────────────────────────────────────────────────────
  const abstract = subject.abstract?.trim() ?? "";
  if (!abstract) {
    blockers.push({
      id: "abstract",
      severity: "blocker",
      message: "The manuscript has no abstract. Scholar indexes the abstract page, which needs one.",
    });
  } else if (abstract.length < MIN_ABSTRACT_CHARS) {
    warnings.push({
      id: "abstract-length",
      severity: "warning",
      message: `The abstract is only ${abstract.length} characters. The JIDA checklist asks for 250–300 words covering background, objective, method, result and conclusion.`,
    });
  }

  // ── Keywords ─────────────────────────────────────────────────────────────
  const keywords = subject.keywords?.filter((k) => k.trim()) ?? [];
  if (keywords.length === 0) {
    warnings.push({
      id: "keywords",
      severity: "warning",
      message: "No keywords are recorded, so citation_keywords will be empty.",
    });
  } else if (keywords.length < MIN_KEYWORDS || keywords.length > MAX_KEYWORDS) {
    warnings.push({
      id: "keywords-count",
      severity: "warning",
      message: `There are ${keywords.length} keywords; the JIDA checklist asks for ${MIN_KEYWORDS}–${MAX_KEYWORDS}.`,
    });
  }

  // ── References ───────────────────────────────────────────────────────────
  const referenceCount = countReferences(subject.references);
  if (referenceCount === 0) {
    warnings.push({
      id: "references",
      severity: "warning",
      message:
        "No reference list is recorded. Scholar builds its citation graph from references, so the article will not link to the work it cites.",
    });
  } else if (referenceCount < MIN_REFERENCES) {
    warnings.push({
      id: "references-count",
      severity: "warning",
      message: `Only ${referenceCount} references are recorded; the JIDA checklist asks for at least ${MIN_REFERENCES}.`,
    });
  }

  // ── Issue ────────────────────────────────────────────────────────────────
  if (!subject.issue) {
    blockers.push({
      id: "issue",
      severity: "blocker",
      message: "The article is not attached to an issue, so it has no volume, issue or year.",
    });
  }

  // ── Full text ────────────────────────────────────────────────────────────
  if (!subject.file) {
    blockers.push({
      id: "file",
      severity: "blocker",
      message: "There is no manuscript file to serve as the full text at citation_pdf_url.",
    });
  } else if (!isPdf(subject.file)) {
    blockers.push({
      id: "file-format",
      severity: "blocker",
      message: `The full text is "${subject.file.originalName}". Google Scholar indexes PDFs — upload a PDF version before marking this article Scholar-ready.`,
    });
  }

  return { ready: blockers.length === 0, blockers, warnings };
}
