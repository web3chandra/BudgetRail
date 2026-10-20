/**
 * Document Insights v1 — unit tests
 * Run: bun test provider/test/insights.test.ts
 */

import { describe, it, expect } from "bun:test";
import { computeInsights } from "../src/lib/insights.js";

describe("computeInsights", () => {
  it("basic word/sentence/paragraph counts", () => {
    const r = computeInsights("Hello world. This is a test.\n\nSecond paragraph here.");
    expect(r.wordCount).toBeGreaterThan(0);
    expect(r.sentenceCount).toBeGreaterThanOrEqual(2);
    expect(r.paragraphCount).toBe(2);
    expect(r.service).toBe("document-insights-v1");
  });

  it("deterministic: identical input → identical output", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const r1 = computeInsights(text);
    const r2 = computeInsights(text);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("frequency table contains word counts", () => {
    const r = computeInsights("cat cat dog cat dog bird");
    expect(r.frequencyTable["cat"]).toBe(3);
    expect(r.frequencyTable["dog"]).toBe(2);
    expect(r.frequencyTable["bird"]).toBe(1);
  });

  it("top10 keywords excludes stop-words", () => {
    const r = computeInsights("the the the blockchain blockchain blockchain solidity solidity");
    const words = r.top10Keywords.map(k => k.word);
    expect(words).not.toContain("the");
    expect(words).toContain("blockchain");
    expect(words).toContain("solidity");
  });

  it("extractive summary: first sentence of each paragraph, up to 3", () => {
    const text = "First para sentence one. First para sentence two.\n\n"
               + "Second para only.\n\nThird para here. More.\n\nFourth para extra.";
    const r = computeInsights(text);
    expect(r.extractiveSummary.length).toBe(3);
    expect(r.extractiveSummary[0]).toContain("First para sentence one");
    expect(r.extractiveSummary[1]).toContain("Second para");
    expect(r.extractiveSummary[2]).toContain("Third para");
  });

  it("readability: short sentences → simple", () => {
    const r = computeInsights("Run. Jump. Go. Stop. Fast. Now.");
    expect(r.readabilityTier).toBe("simple");
  });

  it("readability: long sentences → complex", () => {
    const long = Array(25).fill("word").join(" ") + ".";
    const r = computeInsights(long + " " + long + " " + long);
    expect(r.readabilityTier).toBe("complex");
  });

  it("single word input", () => {
    const r = computeInsights("Hello");
    expect(r.wordCount).toBe(1);
    expect(r.sentenceCount).toBeGreaterThanOrEqual(1);
  });

  it("Unicode multi-byte input does not crash", () => {
    const r = computeInsights("Café résumé naïve — über cool. 日本語テスト。 Üniversität.");
    expect(r.wordCount).toBeGreaterThan(0);
    expect(r.service).toBe("document-insights-v1");
  });

  it("empty-ish input (whitespace only) returns safe zeroes", () => {
    // computeInsights is called AFTER upstream emptiness check, so pass a space.
    const r = computeInsights(" ");
    expect(r.wordCount).toBe(0);
    expect(r.sentenceCount).toBe(0);
  });

  it("frequency table is stable across runs", () => {
    const text = "apple apple banana cherry apple";
    const r = computeInsights(text);
    expect(r.frequencyTable["apple"]).toBe(3);
    expect(r.frequencyTable["banana"]).toBe(1);
  });

  it("top10 is sorted by frequency descending then alphabetically", () => {
    const text = "zebra zebra zebra apple apple banana";
    const r = computeInsights(text);
    expect(r.top10Keywords[0].word).toBe("zebra");
    expect(r.top10Keywords[1].word).toBe("apple");
  });

  it("avgWordsPerSentence and avgSentencesPerParagraph are numeric", () => {
    const r = computeInsights("One two three. Four five.\n\nSix seven eight nine ten.");
    expect(typeof r.avgWordsPerSentence).toBe("number");
    expect(typeof r.avgSentencesPerParagraph).toBe("number");
    expect(isFinite(r.avgWordsPerSentence)).toBe(true);
    expect(isFinite(r.avgSentencesPerParagraph)).toBe(true);
  });
});
