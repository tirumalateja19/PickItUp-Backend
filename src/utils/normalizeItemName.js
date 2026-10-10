// "  cotton   SHIRT " -> "Cotton Shirt"
// Trims, collapses repeated spaces, lowercases, then capitalises each word.
export const normalizeItemName = (name) =>
  String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|\s)(\S)/g, (_, space, char) => space + char.toUpperCase());
