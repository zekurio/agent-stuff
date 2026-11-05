import { homedir } from "node:os";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** Extensions Pi can send as image content. Mime is checked again on submit. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

const PLACEHOLDER = /\[Image #(\d+)\]/g;

export function placeholder(id: number): string {
  return `[Image #${id}]`;
}

export function hasImageExtension(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Placeholder ids in `text`, in order of first appearance. */
export function placeholderIds(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const id = Number(match[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The shape of Intl.Segmenter output that Pi's editor works with. */
export interface Segment {
  segment: string;
  index: number;
  input: string;
  isWordLike?: boolean;
}

/**
 * Merges the segments inside each known placeholder into one, the way Pi's
 * editor merges its [paste #N] markers. Backspace, delete, and cursor moves
 * then treat the placeholder as one character.
 *
 * Pi's word movement treats any segment containing whitespace as whitespace,
 * and Ctrl+W would then also eat the word before the placeholder. With
 * `hideSpaces`, the merged segment's text has spaces swapped for underscores.
 * Its length stays the same, which is all word movement uses.
 */
export function mergePlaceholders(
  text: string,
  segments: Iterable<Segment>,
  isKnown: (id: number) => boolean,
  hideSpaces: boolean,
): Iterable<Segment> {
  if (!text.includes("[Image #")) return segments;
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (isKnown(Number(match[1]))) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (spans.length === 0) return segments;

  const merged: Segment[] = [];
  let next = 0;
  let opened = -1;
  for (const seg of segments) {
    while (next < spans.length && spans[next]!.end <= seg.index) next++;
    const span = spans[next];
    if (span && seg.index === span.start) {
      const label = text.slice(span.start, span.end);
      merged.push({
        segment: hideSpaces ? label.replace(/\s/g, "_") : label,
        index: span.start,
        input: text,
      });
      opened = next;
    } else if (!span || seg.index < span.start || opened !== next) {
      // Outside a span, or a span whose start fell mid-segment.
      merged.push(seg);
    }
    // Other segments inside an opened span are part of the merged one.
  }
  return merged;
}

/**
 * Ways to read pasted or dropped text as a list of file paths, most literal
 * first. Terminals send dropped files as plain paths, shell-quoted or
 * backslash-escaped paths, or file:// URIs, one per line or separated by
 * spaces. The caller keeps the first reading whose paths are all images.
 */
export function pathCandidates(text: string): string[][] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 16_384) return [];

  const readings = [
    // One raw path, which may contain spaces.
    [trimmed],
    // One raw path per line, as macOS file pastes arrive.
    trimmed.split("\n").map((line) => line.trim()).filter(Boolean),
    shellSplit(trimmed) ?? [],
  ];
  const candidates: string[][] = [];
  for (const reading of readings) {
    const paths = reading.map(normalizePath);
    if (paths.length === 0 || !paths.every((path) => path !== undefined)) continue;
    if (!candidates.some((seen) => seen.join("\0") === paths.join("\0"))) {
      candidates.push(paths as string[]);
    }
  }
  return candidates;
}

function normalizePath(token: string): string | undefined {
  if (token.startsWith("file://")) {
    try {
      return fileURLToPath(token);
    } catch {
      return undefined;
    }
  }
  if (token === "~" || token.startsWith("~/")) return homedir() + token.slice(1);
  if (token.startsWith("/")) return token;
  return undefined;
}

/** Splits on unquoted whitespace and honours '', "" and backslash escapes. */
function shellSplit(text: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) tokens.push(current);
  return tokens;
}
