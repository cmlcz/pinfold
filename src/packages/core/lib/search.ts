// A local keyword index over Tools, ranked with BM25.

const k1 = 1.2;
const b = 0.75;
const maxResults = 10;

const stopwords = new Set(
  "a an and are as at be by for from get in is it of on or the to with".split(
    " "
  )
);

/** Ranks documents by their text against a query; returns only matches. */
export function search<T>(
  documents: { item: T; text: string }[],
  query: string
): T[] {
  const docs = documents.map(({ item, text }) => ({
    item,
    terms: tokenize(text),
  }));
  const averageLength =
    docs.reduce((sum, doc) => sum + doc.terms.length, 0) / (docs.length || 1);
  const queryTerms = [...new Set(tokenize(query))];

  const scored = docs.map(({ item, terms }) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = terms.filter((t) => t === term).length;
      if (frequency === 0) continue;
      const containing = docs.filter((doc) => doc.terms.includes(term)).length;
      const idf = Math.log(
        1 + (docs.length - containing + 0.5) / (containing + 0.5)
      );
      const norm = k1 * (1 - b + (b * terms.length) / averageLength);
      score += (idf * frequency * (k1 + 1)) / (frequency + norm);
    }
    return { item, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, maxResults)
    .map(({ item }) => item);
}

// Splits camelCase, snake_case and kebab-case, and folds plurals.
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !stopwords.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word
    );
}
