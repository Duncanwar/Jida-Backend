export function slugify(title: string, idSuffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${base || "article"}-${idSuffix.slice(0, 8)}`;
}
