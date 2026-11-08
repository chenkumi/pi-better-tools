import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { ScreenTranscript } from "../../src/background/index.ts";

const flush = (screen: ScreenTranscript, data: string) => new Promise<void>(resolve => { const off = screen.subscribe(() => { off(); resolve(); }); screen.write(data); });

test("a screen shows the rows up to the last one with text", async () => {
	const screen = new ScreenTranscript(20, 5);
	await flush(screen, "one\r\ntwo\r\n");
	assert.deepEqual(screen.lines().map(plain), ["one", "two", ""], "the cursor row below the text is kept");
	screen.release();
});

test("cursor movement and clearing rewrite the grid like a real terminal", async () => {
	const screen = new ScreenTranscript(20, 5);
	await flush(screen, "hello\r\nworld\x1b[1;1Hjump\x1b[2;1H\x1b[2Kgone");
	assert.deepEqual(screen.lines().map(plain), ["jumpo", "gone"]);
	await flush(screen, "\r10%\r50%\r100%");
	assert.equal(plain(screen.lines()[1]!), "100%", "a carriage-return progress bar overwrites its row instead of adding rows");
	screen.release();
});

test("a full-screen program leaves only the current screen, with no scrollback", async () => {
	const screen = new ScreenTranscript(10, 3);
	await flush(screen, Array.from({ length: 8 }, (_, i) => `line${i}`).join("\r\n"));
	assert.deepEqual(screen.lines().map(plain), ["line5", "line6", "line7"]);
	screen.release();
});

test("only styling comes out; every other escape and control character is dropped", async () => {
	const screen = new ScreenTranscript(40, 4);
	await flush(screen, "\x1b[31mred\x1b[0m \x1b[1;92mbold\x1b[0m \x1b[38;5;200mpink\x1b[0m\x1b]0;title\x07\x1b]52;c;ZXZpbA==\x07 ok‮\u0007");
	const [row] = screen.lines();
	assert.equal(plain(row!), "red bold pink ok");
	assert.match(row!, /\x1b\[0;31mred/); assert.match(row!, /\x1b\[0;1;92mbold/); assert.match(row!, /\x1b\[0;38;5;200mpink/);
	assert.doesNotMatch(row!.replace(/\x1b\[[0-9;]*m/g, ""), /[\x00-\x1f\x7f-\x9f‮]|\x1b/, "nothing but SGR styling survives");
	screen.release();
});

test("resize changes the grid and bursts of output notify at a bounded rate", async () => {
	const screen = new ScreenTranscript(10, 3);
	await flush(screen, "a\r\nb\r\nc");
	screen.resize(10, 5);
	await flush(screen, "\r\nd\r\ne");
	assert.deepEqual(screen.lines().map(plain), ["a", "b", "c", "d", "e"]);
	let notified = 0;
	screen.subscribe(() => { notified++; });
	for (let i = 0; i < 200; i++) screen.write(`x${i}\r\n`);
	await new Promise(resolve => setTimeout(resolve, 350));
	assert.ok(notified >= 1 && notified <= 6, `bounded repaints, got ${notified}`);
	screen.release();
});

test("release drops the grid, tells observers once and ignores later writes", async () => {
	const screen = new ScreenTranscript(10, 3);
	await flush(screen, "secret-ish");
	let calls = 0;
	screen.subscribe(() => { calls++; });
	screen.release(); screen.release();
	assert.equal(calls, 1); assert.equal(screen.isReleased, true);
	screen.write("more"); screen.resize(5, 5);
	assert.deepEqual(screen.lines(), []);
});

test("wide characters keep their whole row", async () => {
	const screen = new ScreenTranscript(30, 3);
	await flush(screen, "建置完成：十個檔案 ok 😀 end");
	assert.equal(plain(screen.lines()[0]!), "建置完成：十個檔案 ok 😀 end");
	screen.release();
});

test("lines are cached per version and refreshed by new output", async () => {
	const screen = new ScreenTranscript(20, 3);
	await flush(screen, "a");
	assert.equal(screen.lines(), screen.lines(), "same array while nothing changed");
	const before = screen.lines();
	await flush(screen, "b");
	assert.notEqual(screen.lines(), before); assert.equal(plain(screen.lines()[0]!), "ab");
	screen.release();
});

test("releasing right after a burst of output neither throws nor leaks an error", async () => {
	const errors: unknown[] = [];
	const onError = (error: unknown) => errors.push(error);
	process.on("uncaughtException", onError);
	try {
		const screen = new ScreenTranscript(80, 24);
		for (let i = 0; i < 500; i++) screen.write(`line ${i}\r\n`.repeat(20));
		screen.release();
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepEqual(screen.lines(), []);
	} finally { process.off("uncaughtException", onError); }
	assert.deepEqual(errors, []);
});

test("the screen lays out emoji, flags, joined sequences and CJK like the terminal does (two cells each)", async () => {
	const { stringWidth } = await import("../../src/background/index.ts");
	for (const [text, width] of [["繁體中文", 8], ["Ａ１", 4], ["😀", 2], ["⚡", 2], ["✓", 1], ["→", 1], ["👨‍👩‍👧", 2], ["🇹🇼", 2], ["👍🏽", 2], ["❤️", 2], ["é", 1]] as const) {
		assert.equal(stringWidth(text), width, JSON.stringify(text));
	}
	const samples = ["中", "😀", "✓", "é", "👨‍👩‍👧", "🇹🇼", "❤️", "Ａ", "가", "⚡", "👍🏽"];
	const screen = new ScreenTranscript(80, 2);
	await flush(screen, samples.join("|"));
	const terminal = (screen as unknown as { terminal: { buffer: { active: { getLine(y: number): { getCell(x: number): { getChars(): string; getWidth(): number } } } } } }).terminal;
	const line = terminal.buffer.active.getLine(0);
	let x = 0;
	for (const sample of samples) {
		assert.equal(line.getCell(x).getChars(), sample, `${JSON.stringify(sample)} starts at cell ${x}`);
		assert.equal(line.getCell(x).getWidth(), stringWidth(sample));
		x += stringWidth(sample) + 1;
	}
	assert.equal(plain(screen.lines()[0]!), samples.join("|"));
	screen.release();
});

test("backgrounds, inverse, dim, italic, underline and true color are kept; painted blanks are not trimmed", async () => {
	const screen = new ScreenTranscript(12, 3);
	await flush(screen, "\x1b[44m menu \x1b[0m\r\n\x1b[7mpick\x1b[0m  \x1b[2;3;4mfaint\x1b[0m\r\n\x1b[38;2;10;20;30mrgb\x1b[0m");
	const [menu, pick, rgb] = screen.lines();
	assert.equal(menu, "\x1b[0;44m menu \x1b[0m", "background-painted blanks stay; unpainted trailing blanks go");
	assert.match(pick!, /^\x1b\[0;7mpick\x1b\[0m {2}\x1b\[0;2;3;4mfaint\x1b\[0m$/);
	assert.equal(rgb, "\x1b[0;38;2;10;20;30mrgb\x1b[0m");
	screen.release();
});

test("hidden text stays hidden", async () => {
	const screen = new ScreenTranscript(20, 2);
	await flush(screen, "pass: \x1b[8mhunter2\x1b[0m");
	assert.equal(plain(screen.lines()[0]!), "pass:");
	screen.release();
});
