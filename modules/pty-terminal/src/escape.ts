/** Decode the explicit control escapes accepted by pty_write. */
export function decodeControlEscapes(input: string): string {
	return input.replace(
		/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([rnftv\\]))/g,
		(_match, u: string | undefined, x: string | undefined, ch: string | undefined) => {
			if (u) return String.fromCharCode(Number.parseInt(u, 16));
			if (x) return String.fromCharCode(Number.parseInt(x, 16));
			switch (ch) {
				case "r":
					return "\r";
				case "n":
					return "\n";
				case "f":
					return "\f";
				case "t":
					return "\t";
				case "v":
					return "\v";
				default:
					return ch ?? "";
			}
		},
	);
}
