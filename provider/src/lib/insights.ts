/**
 * Document Insights v1 — deterministic text analysis.
 *
 * DISCLOSURE: This is a sample paid computation built to demonstrate
 * BudgetRail's payment-gated API pattern.  It is NOT a third-party
 * API and NOT a generative LLM.  Results are fully deterministic:
 * identical UTF-8 input always produces identical output.
 *
 * Metrics computed:
 *   - wordCount, sentenceCount, paragraphCount, characterCount
 *   - avgWordsPerSentence, avgSentencesPerParagraph
 *   - top10Keywords (by frequency, stop-words excluded)
 *   - frequencyTable (all non-stop words)
 *   - extractiveSummary (first sentence of each paragraph, up to 3)
 *   - readabilityTier ("simple" | "moderate" | "complex")
 */

export interface DocumentInsights {
  service:              "document-insights-v1";
  characterCount:       number;
  wordCount:            number;
  sentenceCount:        number;
  paragraphCount:       number;
  avgWordsPerSentence:  number;
  avgSentencesPerParagraph: number;
  top10Keywords:        Array<{ word: string; count: number }>;
  frequencyTable:       Record<string, number>;
  extractiveSummary:    string[];
  readabilityTier:      "simple" | "moderate" | "complex";
}

// Common English stop-words excluded from keyword frequency
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "is","it","its","was","are","be","as","by","that","this","from","have",
  "not","he","she","they","we","you","i","his","her","their","our","your",
  "my","all","will","can","which","do","did","so","if","up","out","had",
  "has","about","more","when","who","no","been","were","than","then","into",
  "such","also","how","what","there","where","these","those","would","could",
  "should","may","might","must","shall","any","each","both","few","more",
  "most","other","some","one","two","three","new","old","first","last",
]);

/** Split text into sentences on .!? boundaries. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Split text into paragraphs on blank lines or \n\n. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

/** Tokenize into lowercase words (letters/hyphens only). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z][a-z'-]*/g) ?? [];
}

/** Round to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute document insights.  Deterministic: same input → same output.
 * @param input — UTF-8 text (already validated for size/emptiness upstream)
 */
export function computeInsights(input: string): DocumentInsights {
  const paragraphs = splitParagraphs(input);
  const sentences  = splitSentences(input);
  const allWords   = tokenize(input);

  // Frequency table over all tokens
  const freq: Record<string, number> = {};
  for (const w of allWords) {
    freq[w] = (freq[w] ?? 0) + 1;
  }

  // Keyword frequency (non-stop, length >= 3)
  const kwFreq: Record<string, number> = {};
  for (const [w, c] of Object.entries(freq)) {
    if (!STOP_WORDS.has(w) && w.length >= 3) {
      kwFreq[w] = c;
    }
  }

  // Top 10 keywords sorted by frequency desc, then alpha for stability
  const top10 = Object.entries(kwFreq)
    .sort(([a, ca], [b, cb]) => cb - ca || a.localeCompare(b))
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));

  // Extractive summary: first sentence of each paragraph, up to 3
  const summary: string[] = [];
  for (const para of paragraphs.slice(0, 3)) {
    const first = splitSentences(para)[0];
    if (first) summary.push(first);
  }

  // Readability tier based on avg words per sentence
  const wordCount     = allWords.length;
  const sentenceCount = Math.max(sentences.length, 1);
  const paraCount     = Math.max(paragraphs.length, 1);
  const avgWps        = round2(wordCount / sentenceCount);

  let readabilityTier: "simple" | "moderate" | "complex";
  if      (avgWps < 12) readabilityTier = "simple";
  else if (avgWps < 20) readabilityTier = "moderate";
  else                  readabilityTier = "complex";

  return {
    service:               "document-insights-v1",
    characterCount:        input.length,
    wordCount,
    sentenceCount:         sentences.length,
    paragraphCount:        paragraphs.length,
    avgWordsPerSentence:   avgWps,
    avgSentencesPerParagraph: round2(sentenceCount / paraCount),
    top10Keywords:         top10,
    frequencyTable:        freq,
    extractiveSummary:     summary,
    readabilityTier,
  };
}
