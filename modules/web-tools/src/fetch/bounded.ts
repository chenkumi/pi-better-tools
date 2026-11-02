import { type ClientRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** The abort reason when it is an Error (deadline, shutdown), else the generic cancellation. */
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('CANCELLED: Fetch was cancelled.');
}

/** Send the request and wait for its response head. Every terminal path settles exactly once: a
 * 101 Upgrade emits neither 'response' nor 'error' (Node hands the socket to 'upgrade' and only then
 * emits 'close'), so without these listeners a hostile or misconfigured server could hold the
 * operation, its queue permit and shutdown forever.  */
export function awaitResponse(request: ClientRequest, signal: AbortSignal, cancelReason: (signal: AbortSignal) => Error,
  upgradeMessage: string, body?: Buffer): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    let pending = true;
    const settle = (error?: Error, value?: IncomingMessage) => {
      if (!pending) return;
      pending = false;
      signal.removeEventListener('abort', onCancel);
      request.off('upgrade', onUpgrade);
      request.off('close', onClose);
      if (error) reject(error); else resolve(value!);
    };
    const onCancel = () => settle(cancelReason(signal));
    const onUpgrade = (_response: IncomingMessage, socket: Duplex) => {
      // The upgraded socket is detached from the request; it must be destroyed explicitly.
      socket.destroy();
      settle(new Error(upgradeMessage));
    };
    const onClose = () => settle(new Error('NETWORK_ERROR: The server closed the connection before sending any response; retry once, or try a different URL.'));
    request.once('response', (value: IncomingMessage) => settle(undefined, value));
    request.once('upgrade', onUpgrade);
    request.once('close', onClose);
    signal.addEventListener('abort', onCancel, { once: true });
    // Stays attached after settlement so a late socket error is never unhandled.
    request.on('error', (error: Error) => settle(error));
    request.end(body);
  });
}
