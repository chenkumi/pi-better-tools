import { TLSSocket } from 'node:tls';

type PeerCertificate = ReturnType<TLSSocket['getPeerCertificate']>;

let installed = false;

/**
 * Node returns null from getPeerCertificate() after a TLS socket is destroyed.
 * Playwright's route.fetch() implementation reads valid_from without handling
 * that documented result, which otherwise becomes an uncaught exception.
 */
export function certificateOrEmpty(certificate: PeerCertificate | null): PeerCertificate | Record<string, never> {
  return certificate ?? {};
}

export function installPlaywrightTlsCompatibility(): void {
  if (installed) return;
  installed = true;
  const getPeerCertificate = TLSSocket.prototype.getPeerCertificate;
  const safeGetPeerCertificate = function (this: TLSSocket, detailed?: boolean) {
    return certificateOrEmpty(getPeerCertificate.call(this, detailed));
  };
  TLSSocket.prototype.getPeerCertificate = safeGetPeerCertificate as typeof TLSSocket.prototype.getPeerCertificate;
}
