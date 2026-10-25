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
  const words = tokenize(query);
  // A query of stopwords only, such as "get", still finds the Tools it names.
  const ignored = words.every((word) => stopwords.has(word))
    ? new Set<string>()
    : stopwords;
  const docs = documents.map(({ item, text }) => ({
    item,
    terms: tokenize(text).filter((term) => !ignored.has(term)),
  }));
  const averageLength =
    docs.reduce((sum, doc) => sum + doc.terms.length, 0) / (docs.length || 1);
  const kept = words.filter((word) => !ignored.has(word));
  // A term's IDF depends on the documents only, so it is computed once.
  const queryTerms = [...new Set(kept)].map((term) => {
    const containing = docs.filter((doc) => doc.terms.includes(term)).length;
    const idf = Math.log(
      1 + (docs.length - containing + 0.5) / (containing + 0.5)
    );
    return { term, idf };
  });

  const scored = docs.map(({ item, terms }) => {
    let score = 0;
    for (const { term, idf } of queryTerms) {
      const frequency = terms.filter((t) => t === term).length;
      if (frequency === 0) continue;
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

// Splits camelCase, snake_case and kebab-case into words of any script, and
// folds plurals. Han and kana run on without spaces, so each of their
// characters is a word.
function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/gu, " $& ")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) =>
      word.length > 2 && word.endsWith("s") ? word.slice(0, -1) : word
    );
}
