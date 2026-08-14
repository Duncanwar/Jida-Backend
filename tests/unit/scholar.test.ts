/**
 * Google Scholar readiness checks. Blockers are the things that make indexing
 * fail outright; warnings degrade the record but still index.
 */
import { describe, expect, it } from "vitest";
import { checkScholarReadiness, type ScholarSubject } from "../../src/services/scholar.js";

/** A manuscript that satisfies every requirement. */
function ready(overrides: Partial<ScholarSubject> = {}): ScholarSubject {
  return {
    title: "Effects of Teamwork on Teachers' Performance",
    abstract: "A".repeat(400),
    keywords: ["teamwork", "performance", "education"],
    references: Array.from({ length: 18 }, (_, i) => `Reference ${i + 1}`).join("\n"),
    author: { firstName: "Darren", lastName: "Iraguha", affiliation: "AUCA, Kigali, Rwanda" },
    coAuthors: [{ fullName: "Charles Babbage", affiliation: "AUCA" }],
    issue: { volume: 7, issueNumber: 1, year: 2026 },
    file: { originalName: "paper.pdf", mimeType: "application/pdf" },
    ...overrides,
  };
}

const ids = (checks: { id: string }[]) => checks.map((c) => c.id);

describe("checkScholarReadiness", () => {
  it("passes a complete manuscript with no blockers or warnings", () => {
    const result = checkScholarReadiness(ready());
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("blocks a DOCX full text — Scholar indexes PDFs", () => {
    const result = checkScholarReadiness(
      ready({
        file: {
          originalName: "paper.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    );
    expect(result.ready).toBe(false);
    expect(ids(result.blockers)).toContain("file-format");
    expect(result.blockers[0].message).toContain("paper.docx");
  });

  it("accepts a PDF whose mime type was not recorded, by extension", () => {
    const result = checkScholarReadiness(
      ready({ file: { originalName: "paper.PDF", mimeType: "application/octet-stream" } }),
    );
    expect(ids(result.blockers)).not.toContain("file-format");
  });

  it("blocks when there is no full text at all", () => {
    const result = checkScholarReadiness(ready({ file: null }));
    expect(ids(result.blockers)).toContain("file");
  });

  it("blocks an author with no real name", () => {
    const result = checkScholarReadiness(
      ready({ author: { firstName: null, lastName: null, affiliation: "AUCA" } }),
    );
    expect(ids(result.blockers)).toContain("author-name");
  });

  it("blocks a nameless co-author, since each needs its own citation_author", () => {
    const result = checkScholarReadiness(
      ready({ coAuthors: [{ fullName: "   ", affiliation: null }] }),
    );
    expect(ids(result.blockers)).toContain("coauthor-name");
  });

  it("blocks a missing abstract and a missing issue", () => {
    const result = checkScholarReadiness(ready({ abstract: "", issue: null }));
    expect(ids(result.blockers)).toEqual(expect.arrayContaining(["abstract", "issue"]));
  });

  it("warns, without blocking, on a short abstract", () => {
    const result = checkScholarReadiness(ready({ abstract: "Too short." }));
    expect(result.ready).toBe(true);
    expect(ids(result.warnings)).toContain("abstract-length");
  });

  it("warns when the affiliation is missing", () => {
    const result = checkScholarReadiness(
      ready({ author: { firstName: "Darren", lastName: "Iraguha", affiliation: null } }),
    );
    expect(result.ready).toBe(true);
    expect(ids(result.warnings)).toContain("author-affiliation");
  });

  it("warns when the keyword count falls outside the checklist's 3-8", () => {
    expect(ids(checkScholarReadiness(ready({ keywords: ["one", "two"] })).warnings)).toContain(
      "keywords-count",
    );
    expect(ids(checkScholarReadiness(ready({ keywords: [] })).warnings)).toContain("keywords");
  });

  it("warns when there are fewer than fifteen references", () => {
    const result = checkScholarReadiness(ready({ references: "One\nTwo\nThree" }));
    expect(ids(result.warnings)).toContain("references-count");
    expect(result.warnings.find((w) => w.id === "references-count")?.message).toContain("3");
  });

  it("ignores blank lines when counting references", () => {
    const spaced = Array.from({ length: 16 }, (_, i) => `Reference ${i + 1}`).join("\n\n");
    expect(ids(checkScholarReadiness(ready({ references: spaced })).warnings)).not.toContain(
      "references-count",
    );
  });

  it("warns on a title long enough for Scholar to truncate", () => {
    const result = checkScholarReadiness(ready({ title: "T".repeat(260) }));
    expect(result.ready).toBe(true);
    expect(ids(result.warnings)).toContain("title-length");
  });

  it("blocks an empty title", () => {
    expect(ids(checkScholarReadiness(ready({ title: "  " })).blockers)).toContain("title");
  });
});
