import { describe, expect, it } from "vitest";
import { slugify } from "../../src/utils/slug.js";

describe("slugify", () => {
  it("lowercases and replaces non-alphanumerics with dashes", () => {
    expect(slugify("Hello World!", "abcdefgh1234")).toBe("hello-world-abcdefgh");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("--Weird Title--", "12345678")).toBe("weird-title-12345678");
  });

  it("truncates the base to 80 characters", () => {
    const long = "a".repeat(200);
    const slug = slugify(long, "12345678");
    expect(slug).toBe(`${"a".repeat(80)}-12345678`);
  });

  it("falls back to 'article' when the title has no usable characters", () => {
    expect(slugify("!!!", "12345678")).toBe("article-12345678");
  });

  it("uses only the first 8 characters of the id suffix", () => {
    expect(slugify("Title", "aaaabbbbccccdddd")).toBe("title-aaaabbbb");
  });
});
