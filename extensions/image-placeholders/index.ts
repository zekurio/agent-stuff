import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  detectSupportedImageMimeTypeFromFile,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  hasImageExtension,
  mergePlaceholders,
  pathCandidates,
  placeholder,
  placeholderIds,
  type Segment,
} from "./placeholders.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** More dropped files than this are pasted as text. */
const MAX_IMAGES_PER_PASTE = 20;

/**
 * Ids grow for the life of the Pi process, as in Claude Code, so a prompt
 * recalled from history or a queued message returned to the editor still
 * points at its own image.
 */
class ImageRegistry {
  private paths = new Map<number, string>();
  private lastId = 0;

  add(path: string): number {
    this.paths.set(++this.lastId, path);
    return this.lastId;
  }

  get(id: number): string | undefined {
    return this.paths.get(id);
  }

  has(id: number): boolean {
    return this.paths.has(id);
  }
}

function isImageFile(path: string): boolean {
  if (!hasImageExtension(path)) return false;
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

type EditorArgs = ConstructorParameters<typeof CustomEditor>;

/** Editor's private segmenter. Every edit and cursor move goes through it. */
type Segmenter = (text: string, mode?: "grapheme" | "word") => Iterable<Segment>;

/**
 * Shows pasted and dropped images as [Image #N] instead of their file paths.
 * Ctrl+V reaches insertTextAtCursor with the temp file Pi saved the clipboard
 * image to. Drag and drop arrives as a bracketed paste of the file's path.
 */
class ImageEditor extends CustomEditor {
  private readonly images: ImageRegistry;
  private bracketedPaste: string | undefined;

  constructor(images: ImageRegistry, ...args: EditorArgs) {
    super(...args);
    this.images = images;
    this.makePlaceholdersAtomic();
  }

  /**
   * Pi has no public hook for atomic markers, so this wraps the editor's
   * private segment(). If a Pi update renames it, placeholders fall back to
   * deleting one character at a time.
   */
  private makePlaceholdersAtomic(): void {
    const editor = this as unknown as { segment?: Segmenter };
    const base = editor.segment;
    if (typeof base !== "function") return;
    editor.segment = (text, mode) =>
      mergePlaceholders(
        text,
        base.call(this, text, mode),
        (id) => this.images.has(id),
        mode === "word",
      );
  }

  override insertTextAtCursor(text: string): void {
    if (!this.insertImages(text)) super.insertTextAtCursor(text);
  }

  override handleInput(data: string): void {
    if (this.bracketedPaste === undefined) {
      const start = data.indexOf(PASTE_START);
      if (start === -1) {
        super.handleInput(data);
        return;
      }
      if (start > 0) super.handleInput(data.slice(0, start));
      this.bracketedPaste = "";
      data = data.slice(start + PASTE_START.length);
    }

    this.bracketedPaste += data;
    const end = this.bracketedPaste.indexOf(PASTE_END);
    if (end === -1) return;

    const content = this.bracketedPaste.slice(0, end);
    const rest = this.bracketedPaste.slice(end + PASTE_END.length);
    this.bracketedPaste = undefined;
    if (!this.insertImages(content)) {
      super.handleInput(PASTE_START + content + PASTE_END);
    }
    if (rest) this.handleInput(rest);
  }

  private insertImages(text: string): boolean {
    // Bash mode wants the real path.
    if (this.getText().trimStart().startsWith("!")) return false;

    const paths = pathCandidates(text).find(
      (candidate) => candidate.length <= MAX_IMAGES_PER_PASTE && candidate.every(isImageFile),
    );
    if (!paths) return false;

    const labels = paths.map((path) => placeholder(this.images.add(path))).join(" ");
    const { line, col } = this.getCursor();
    const current = this.getLines()[line] ?? "";
    const before = col > 0 && !/\s/.test(current[col - 1]!) ? " " : "";
    const after = /\s/.test(current[col] ?? "") ? "" : " ";
    super.insertTextAtCursor(before + labels + after);
    return true;
  }
}

export default function imagePlaceholders(pi: ExtensionAPI) {
  const images = new ImageRegistry();

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent((...args) => new ImageEditor(images, ...args));
  });

  // Attach the images behind each placeholder, so the model sees them in the
  // prompt instead of reading a temp file with the read tool.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const attached: ImageContent[] = [];
    for (const id of placeholderIds(event.text)) {
      const path = images.get(id);
      if (!path) continue;
      try {
        const mimeType = await detectSupportedImageMimeTypeFromFile(path);
        if (!mimeType) throw new Error("unsupported image format");
        const data = (await readFile(path)).toString("base64");
        attached.push({ type: "image", mimeType, data });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`${placeholder(id)} not attached: ${reason}`, "warning");
      }
    }
    if (attached.length === 0) return { action: "continue" };

    return {
      action: "transform",
      text: event.text,
      images: [...(event.images ?? []), ...attached],
    };
  });
}
