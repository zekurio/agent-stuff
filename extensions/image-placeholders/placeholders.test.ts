import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { hasImageExtension, mergePlaceholders, pathCandidates, placeholder, placeholderIds } from "./placeholders.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const known = (id: number) => id === 1 || id === 2;

function mergedTexts(text: string, segmenter: Intl.Segmenter, hideSpaces = false): string[] {
  return [...mergePlaceholders(text, segmenter.segment(text), known, hideSpaces)].map(
    (seg) => seg.segment,
  );
}

test("mergePlaceholders makes known placeholders one grapheme", () => {
  const segs = mergedTexts("a[Image #1]b [Image #2]", graphemes);
  assert.deepEqual(segs, ["a", "[Image #1]", "b", " ", "[Image #2]"]);
});

test("mergePlaceholders leaves unknown placeholders alone", () => {
  assert.equal(mergedTexts("[Image #9]", graphemes).length, 10);
});

test("mergePlaceholders hides spaces in word segments and keeps offsets", () => {
  const text = "see [Image #1] now";
  const segs = [...mergePlaceholders(text, words.segment(text), known, true)];
  const placeholderSeg = segs.find((seg) => seg.segment === "[Image_#1]");
  assert.equal(placeholderSeg?.index, 4);
  assert.equal(placeholderSeg?.isWordLike, undefined);
  assert.equal(segs.map((seg) => seg.segment).join("").length, text.length);
});

test("placeholderIds returns ids in order without repeats", () => {
  const text = `see ${placeholder(3)} and ${placeholder(1)}, again ${placeholder(3)}`;
  assert.deepEqual(placeholderIds(text), [3, 1]);
  assert.deepEqual(placeholderIds("[Image #x] [image #2]"), []);
});

test("hasImageExtension ignores case and rejects other files", () => {
  assert.equal(hasImageExtension("/tmp/a.PNG"), true);
  assert.equal(hasImageExtension("/tmp/a.jpeg"), true);
  assert.equal(hasImageExtension("/tmp/a.pdf"), false);
  assert.equal(hasImageExtension("/tmp/png"), false);
});

test("pathCandidates reads a raw path with spaces literally first", () => {
  assert.deepEqual(pathCandidates("/tmp/my shot.png\n")[0], ["/tmp/my shot.png"]);
});

test("pathCandidates unquotes and unescapes dropped paths", () => {
  const candidates = pathCandidates(`'/tmp/a b.png' /tmp/c\\ d.png "/tmp/e.png"`);
  assert.deepEqual(candidates.at(-1), ["/tmp/a b.png", "/tmp/c d.png", "/tmp/e.png"]);
});

test("pathCandidates reads one path per line", () => {
  assert.ok(
    pathCandidates("/tmp/a b.png\n/tmp/c.png").some(
      (paths) => paths.join("|") === "/tmp/a b.png|/tmp/c.png",
    ),
  );
});

test("pathCandidates decodes file URIs and expands ~", () => {
  assert.deepEqual(pathCandidates("file:///tmp/a%20b.png")[0], ["/tmp/a b.png"]);
  assert.deepEqual(pathCandidates("~/shot.png")[0], [`${homedir()}/shot.png`]);
});

test("pathCandidates rejects text that is not only paths", () => {
  assert.deepEqual(pathCandidates("look at /tmp/a.png"), []);
  assert.deepEqual(pathCandidates("relative.png"), []);
  assert.deepEqual(pathCandidates("   "), []);
});
