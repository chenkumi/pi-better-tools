import assert from "node:assert/strict";
import test from "node:test";
import { MASK, SecretMasker } from "../src/secret-mask.ts";

const masker = (...secrets: string[]) => { const m = new SecretMasker(); for (const s of secrets) m.add(s); return m; };

test("without secrets the view is the input unchanged", () => {
	const view = new SecretMasker().view("abc\r\n");
	assert.deepEqual([view.text, view.count, view.rawLength, view.toRaw(3)], ["abc\r\n", 0, 5, 3]);
});

test("a secret echoed as a failed command is masked, in both places and with the surrounding text intact", () => {
	const view = masker("ThisIsPassword").view("[admin@localhost ~]$ ThisIsPassword\r\nbash: ThisIsPassword: 找不到指令...\r\n[admin@localhost ~]$ ");
	assert.equal(view.text, `[admin@localhost ~]$ ${MASK}\r\nbash: ${MASK}: 找不到指令...\r\n[admin@localhost ~]$ `);
	assert.equal(view.count, 2);
	assert.ok(!view.text.includes("ThisIs"));
});

test("the mask has a fixed length so the secret length is not revealed", () => {
	assert.equal(masker("ab").view("ab").text, MASK);
	assert.equal(masker("a-very-long-secret-value").view("a-very-long-secret-value").text, MASK);
});

test("escape sequences, CR/LF and backspaces between the echoed characters do not hide the secret", () => {
	const m = masker("hunter2");
	assert.equal(m.view("x \x1b[1mhun\x1b[0mter\r\n2 y").text, `x \x1b[1m${MASK} y`); // only escapes inside the secret go with it
	assert.equal(m.view("h\x1b[Cu\x1b[Cn\x1b[Ct\x1b[Ce\x1b[Cr\x1b[C2").text, MASK);
	assert.equal(m.view("hun\x1b]0;title\x07ter2").text, MASK);
	assert.equal(m.view("hunter\b2").text, MASK);
});

test("text that merely looks similar is left alone", () => {
	const m = masker("hunter2");
	for (const text of ["hunter", "hunter3", "hun ter2", "Hunter2", "hunter 2"]) assert.equal(m.view(text, true).text, text);
});

test("a secret split across two reads is never shown in halves", () => {
	const m = masker("hunter2");
	const first = m.view("login: hun");
	assert.equal(first.text, "login: ");
	assert.equal(first.rawLength, "login: ".length, "the possible start of the secret is held back, not consumed");
	const second = m.view("hun" + "ter2 done"); // the next read starts from the held-back cursor
	assert.equal(second.text, `${MASK} done`);
});

test("a held-back tail is released once the session ended or the text cannot complete the secret", () => {
	const m = masker("hunter2");
	assert.equal(m.view("login: hun", true).text, "login: hun");
	assert.equal(m.view("login: hun!").text, "login: hun!");
	assert.equal(m.view("end h").text, "end ");
});

test("a complete secret at the very end is masked, not held back", () => {
	const view = masker("aa").view("xaa");
	assert.equal(view.text, `x${MASK}`);
	assert.equal(view.rawLength, 3);
});

test("a longer secret that contains a shorter one is masked as a whole", () => {
	const m = masker("pass", "pass1234");
	assert.equal(m.view("pass1234 and pass").text, `${MASK} and ${MASK}`);
});

test("toRaw maps text offsets back to raw offsets across masks", () => {
	const raw = "ab secret cd secret ef";
	const view = masker("secret").view(raw);
	assert.equal(view.text, `ab ${MASK} cd ${MASK} ef`);
	assert.equal(view.toRaw(view.text.length), raw.length);
	assert.equal(view.toRaw(3), 3);
	assert.equal(view.toRaw(5), 3, "inside a mask maps to where the secret began");
	assert.equal(view.toRaw(3 + MASK.length), 3 + "secret".length);
	assert.equal(view.toRaw(view.text.indexOf("ef")), raw.indexOf("ef"));
});

test("regex metacharacters and control characters in a secret are matched literally", () => {
	const secret = "a.b*c+d?(e)[f]{g}|h^i$j\\k/l-m";
	assert.equal(masker(secret).view(`x ${secret} y`).text, `x ${MASK} y`);
	assert.equal(masker(secret).view("x aXb*c+d?(e)[f]{g}|h^i$j\\k/l-m y", true).text, "x aXb*c+d?(e)[f]{g}|h^i$j\\k/l-m y");
	assert.equal(masker("tab\there").view("tab\there").text, MASK);
});

test("an empty or repeated secret is ignored and clear forgets everything", () => {
	const m = new SecretMasker();
	assert.equal(m.add(""), false);
	assert.equal(m.add("abc"), true);
	assert.equal(m.add("abc"), false);
	assert.equal(m.size, 1);
	m.clear();
	assert.equal(m.view("abc").text, "abc");
});

test("a very short secret masks every occurrence (documented over-masking)", () => {
	assert.equal(masker("1").view("a1b11").text, `a${MASK}b${MASK}${MASK}`);
});

test("a start inside a secret skips the rest of that secret instead of showing its tail", () => {
	const raw = "$ echo hunter2pw\r\nok";
	const inside = raw.indexOf("hunter2pw") + 3;
	const m = masker("hunter2pw");
	const view = m.view(raw, true, inside);
	assert.equal(view.text, "\r\nok");
	assert.equal(view.rawStart, raw.indexOf("\r\n"));
	assert.equal(view.toRaw(2), 2);
	const before = m.view(raw, true, raw.indexOf("hunter2pw"));
	assert.equal(before.text, `${MASK}\r\nok`, "a start at the secret's first character still masks it");
	assert.equal(m.view(raw, true, raw.indexOf("hunter2pw") + "hunter2pw".length).text, "\r\nok");
});

test("a start before a mask keeps toRaw relative to the start", () => {
	const raw = "ab secret cd";
	const view = masker("secret").view(raw, true, 1);
	assert.equal(view.text, `b ${MASK} cd`);
	assert.equal(view.toRaw(view.text.length), raw.length - 1);
	assert.equal(view.toRaw(view.text.indexOf("cd")), raw.indexOf("cd") - 1);
});
