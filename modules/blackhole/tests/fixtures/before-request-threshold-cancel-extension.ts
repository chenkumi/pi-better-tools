// Diagnostic fixture only: exercise the approved public threshold-cancellation boundary.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
  pi.on("session_before_compact", (event) => event.reason === "threshold" ? { cancel: true } : undefined);
}
