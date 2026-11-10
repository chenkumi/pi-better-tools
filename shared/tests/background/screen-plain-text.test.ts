import assert from "node:assert/strict";
import test from "node:test";
import { ScreenTranscript } from "../../src/background/index.ts";

const write = async (screen: ScreenTranscript, data: string) => { screen.write(data); await screen.flush(); };

test("plainText is the screen as a reader sees it: no styling, overwrites applied, trailing blanks trimmed, the cursor located", async () => {
	const screen = new ScreenTranscript(20, 5);
	await write(screen, "\x1b[31mred\x1b[0m one\r\nhello\x1b[1;1Hjump\x1b[3;1Hbar\x1b[2;3H");
	const shot = screen.plainText()!;
	assert.equal(shot.text, "jumpone\nhello\nbar");
	assert.deepEqual([shot.cols, shot.rows, shot.alternate], [20, 5, false]);
	assert.deepEqual(shot.cursor, { line: 2, column: 3 });
	assert.doesNotMatch(shot.text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, "no control characters");
	screen.release();
	assert.equal(screen.plainText(), undefined);
});

test("plainText joins rows the terminal wrapped itself, keeps blank rows inside and hides hidden text", async () => {
	const screen = new ScreenTranscript(10, 6);
	await write(screen, "0123456789ABCDE\r\n\r\nlast\x1b[8mhidden\x1b[0m");
	const shot = screen.plainText()!;
	assert.deepEqual(shot.text.split("\n"), ["0123456789ABCDE", "", "last"]);
	assert.doesNotMatch(shot.text, /hidden/);
	assert.equal(shot.cursor.line, 3);
	screen.release();
});

test("flush waits for queued output, and alternate reports a full-screen program", async () => {
	const screen = new ScreenTranscript(20, 4);
	await write(screen, "before");
	assert.equal(screen.plainText()!.text, "before");
	assert.equal(screen.alternate, false);
	await write(screen, "\x1b[?1049h\x1b[Hfull screen");
	assert.equal(screen.alternate, true);
	assert.equal(screen.plainText()!.text, "full screen");
	await write(screen, "\x1b[?1049l");
	assert.equal(screen.alternate, false);
	assert.equal(screen.plainText()!.text, "before");
	screen.release();
	await screen.flush(); // after release: resolves at once
});
