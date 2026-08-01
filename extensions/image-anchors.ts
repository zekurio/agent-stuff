import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const CLIPBOARD_IMAGE_NAME = /^pi-clipboard-[^.]+\.(?:png|jpe?g|gif|webp|bmp)$/i;
const MIME_TYPES: Record<string, string> = {
	".bmp": "image/bmp",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

type SubmitHandler = (text: string) => void;
type AnchorStyle = (anchor: string) => string;

class ImageRegistry {
	private readonly images = new Map<string, string>();
	private nextImageNumber = 1;

	register(imagePath: string): string {
		for (const [anchor, registeredPath] of this.images) {
			if (registeredPath === imagePath) return anchor;
		}

		const anchor = `[Image ${this.nextImageNumber++}]`;
		this.images.set(anchor, imagePath);
		return anchor;
	}

	entries(): IterableIterator<[string, string]> {
		return this.images.entries();
	}

	expandAnchors(text: string): string {
		let expanded = text;
		for (const [anchor, imagePath] of this.images) {
			expanded = expanded.split(anchor).join(imagePath);
		}
		return expanded;
	}

	collapsePaths(text: string): string {
		let collapsed = text;
		for (const [anchor, imagePath] of this.images) {
			collapsed = collapsed.split(imagePath).join(anchor);
		}
		return collapsed;
	}
}

/**
 * Shows Pi's clipboard image paths as compact anchors in the editor. The paths
 * are restored for Pi's input pipeline, where the extension turns them into
 * real image attachments before the message is stored or sent to the model.
 */
class ImageAnchorEditor extends CustomEditor {
	private submitHandler: SubmitHandler | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly registry: ImageRegistry,
		private readonly styleAnchor: AnchorStyle,
	) {
		super(tui, theme, keybindings);

		// Editor.submitValue() reads this.onSubmit directly. Use an accessor so
		// Pi can install its normal callback while we expand anchors just before
		// the prompt enters Pi's input pipeline.
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			get: () => {
				if (!this.submitHandler) return undefined;
				return (text: string) =>
					this.submitHandler?.(this.registry.expandAnchors(text));
			},
			set: (handler: SubmitHandler | undefined) => {
				this.submitHandler = handler;
			},
		});
	}

	override insertTextAtCursor(text: string): void {
		if (this.isClipboardImagePath(text)) {
			super.insertTextAtCursor(this.registry.register(text));
			return;
		}

		super.insertTextAtCursor(text);
	}

	override getExpandedText(): string {
		return this.registry.expandAnchors(super.getExpandedText());
	}

	override setText(text: string): void {
		super.setText(this.registry.collapsePaths(text));
	}

	override addToHistory(text: string): void {
		// Pi adds the expanded submitted prompt to history. Collapse it again so
		// recalling a prompt keeps the compact anchors.
		super.addToHistory(this.registry.collapsePaths(text));
	}

	override render(width: number): string[] {
		return super.render(width).map((line) => {
			let styled = line;
			for (const [anchor] of this.registry.entries()) {
				styled = styled.split(anchor).join(this.styleAnchor(anchor));
			}
			return styled;
		});
	}

	private isClipboardImagePath(text: string): boolean {
		return (
			isAbsolute(text) &&
			CLIPBOARD_IMAGE_NAME.test(basename(text)) &&
			existsSync(text)
		);
	}
}

function imageContent(imagePath: string): ImageContent | undefined {
	const mimeType = MIME_TYPES[extname(imagePath).toLowerCase()];
	if (!mimeType || !existsSync(imagePath)) return undefined;

	return {
		type: "image",
		data: readFileSync(imagePath).toString("base64"),
		mimeType,
	};
}

export default function imageAnchors(pi: ExtensionAPI) {
	const registry = new ImageRegistry();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new ImageAnchorEditor(
					tui,
					theme,
					keybindings,
					registry,
					(anchor) => ctx.ui.theme.fg("accent", ctx.ui.theme.bold(anchor)),
				),
		);
	});

	pi.on("input", (event) => {
		let text = event.text;
		const images = [...(event.images ?? [])];
		let transformed = false;

		for (const [anchor, imagePath] of registry.entries()) {
			if (!text.includes(imagePath)) continue;

			const image = imageContent(imagePath);
			if (!image) continue;

			// Inline code supplies a distinct Markdown color in the sent message;
			// strong emphasis keeps the label bold.
			text = text.split(imagePath).join(`**\`${anchor}\`**`);
			images.push(image);
			transformed = true;
		}

		if (!transformed) return { action: "continue" };
		return { action: "transform", text, images };
	});
}
