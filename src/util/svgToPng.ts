// Rasterise a drawing's exported SVG into a PNG data URL.
//
// This runs in the plugin's main script, i.e. inside Joplin's hidden plugin
// BrowserWindow: PluginRunner.ts creates it with `show: false`,
// `nodeIntegration: true`, `contextIsolation: false` and loads
// `plugin_index.html` into it, so it is a real Chromium window and `Image`,
// `document` and `<canvas>` are all available here — but see the DOMParser
// warning below before reaching for the rest of the DOM API.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// Joplin already has a "Copy image" action, but in the Markdown *editor* it
// decodes the resource with Electron's nativeImage, which cannot read SVG
// (laurent22/joplin#15878) — so for an Excalidraw drawing it silently copies
// nothing. (The *viewer*'s "Copy image" works, because there the browser copies
// the already-rendered bitmap.) `joplin.clipboard.writeImage()` likewise only
// takes a raster data URL. So to copy a drawing as an image the plugin has to
// produce the bitmap itself, which is what this file does.
//
// Dark drawings carry Excalidraw's invert filter on the root <svg>
// (`filter="invert(…) hue-rotate(180deg) …"`, written by `exportToSvg` when the
// scene's theme is dark). Chromium applies that filter while painting the SVG
// through an <img>, so a dark drawing rasterises dark with no extra handling —
// exactly what the note viewer already shows.
//
// NEVER PARSE THE DRAWING WITH DOMParser HERE
// -------------------------------------------
// The SVG arrives from `readDiagramSvg()`, i.e. from Node's `fs.readFile()` via
// `joplin.require('fs-extra')`. Node hands back an *external* V8 string once the
// result grows past its EXTERN_APEX threshold (0xFBEE9 = 1_031_401 bytes, see
// node/src/string_bytes.cc), and feeding such a string to
// `DOMParser.parseFromString()` in this window never returns: the renderer's
// main thread stops answering for good, at 0% CPU and with no error, no
// exception and no crash dump. Nothing in the plugin recovers from that — its
// commands, its Tools menu, its toolbar button and its editor context-menu
// entries all go dead until Joplin is restarted, because every one of them is a
// callback living in this very renderer.
//
// Measured on Joplin 3.7.14 (Electron 38 / Chromium 148), one drawing per run:
//
//   768 KB from fs.readFile   -> parses in 11 ms
//   1 MB+ from fs.readFile    -> renderer wedged, plugin dead
//   1.7 MB built in JS        -> parses in 8 ms
//   1.7 MB from fs.readFile   -> renderer wedged, plugin dead
//
// So it is the string's provenance and size, not the SVG: a drawing with a
// screenshot pasted into it sails past 1 MB and takes the plugin down with it.
// The size is therefore read off the opening <svg> tag with a regex, and the
// loaded <img> is the fallback — neither goes near a DOM parser.

// Drawn at 2x so the PNG still looks crisp when pasted on a HiDPI screen...
export const PNG_SCALE = 2;
// ...but never larger than this on the longer side, to keep the clipboard sane.
export const PNG_MAX_SIDE = 4096;

// A CSS pixel length: a bare number, or one with an explicit px. Anything
// relative ("100%", "20em") is NOT a pixel size and is refused, so the caller
// falls through to the viewBox — which is what a browser sizes such an SVG by.
const parseLength = (value: string | null): number => {
	if (!value) return 0;
	const match = /^\s*([0-9.eE+-]+)\s*(px)?\s*$/.exec(String(value));
	if (!match) return 0;
	const parsed = parseFloat(match[1]);
	return isFinite(parsed) && parsed > 0 ? parsed : 0;
};

// One attribute off the opening <svg> tag. Only the tag itself is scanned, so
// the megabytes of drawing behind it cost nothing. The leading \s matters — a
// bare \bwidth would also match "stroke-width".
const attributeFromOpenTag = (svgText: string, name: string): string | null => {
	const openTag = /<svg[\s>][^>]*>/i.exec(svgText);
	if (!openTag) return null;
	const pattern = new RegExp('[\\s]' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i');
	const match = pattern.exec(openTag[0]);
	if (!match) return null;
	return match[1] !== undefined ? match[1] : match[2];
};

// The drawing's size in CSS pixels: the root <svg>'s width/height, falling back
// to the last two numbers of its viewBox. Zero for an SVG this cannot read, so
// the caller can fall back to the size Chromium gave the loaded image.
export const svgPixelSize = (svgText: string): { width: number, height: number } => {
	const attribute = (name: string): string | null => attributeFromOpenTag(svgText, name);

	let width = parseLength(attribute('width'));
	let height = parseLength(attribute('height'));

	if (!width || !height) {
		const viewBox = String(attribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
		if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
			width = width || viewBox[2];
			height = height || viewBox[3];
		}
	}

	return { width, height };
};

const loadImage = (url: string): Promise<HTMLImageElement> => {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error('could not rasterise the drawing SVG'));
		image.src = url;
	});
};

export const svgToPngDataUrl = async (svgText: string): Promise<string> => {
	// A data: URL keeps the SVG self-contained. An <img> cannot fetch external
	// resources anyway, so nothing is lost compared to a blob: URL.
	const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
	const image = await loadImage(url);

	// The declared size first — it is what the note viewer renders the drawing
	// at, to the decimal — then the intrinsic size of the image Chromium has
	// just decoded, which is a whole-pixel rounding of the same thing.
	const declared = svgPixelSize(svgText);
	const width = declared.width || image.naturalWidth || 1;
	const height = declared.height || image.naturalHeight || 1;

	const scale = Math.min(PNG_SCALE, PNG_MAX_SIDE / Math.max(width, height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));

	const context = canvas.getContext('2d');
	if (!context) throw new Error('could not get a 2d canvas context');
	context.drawImage(image, 0, 0, canvas.width, canvas.height);

	return canvas.toDataURL('image/png');
};
