# Security policy

PixelGate is experimental. The actively maintained version is the default branch.

## Report a vulnerability

Use **Security → Advisories → Report a vulnerability** on the repository for private reporting when enabled. Do not open a public issue with exploitable details. Include the affected commit, browser/OS, reproduction steps using synthetic data, and impact. There is no guaranteed response time or security certification.

## Trust model

Users load the trusted app, share a temporary six-digit receiver code, and explicitly approve their intended sender. Codes expire after ten minutes, accept one sender, and are released after approval. Six digits are a convenient lookup, not identity authentication. Know which device is waiting for approval and use a trusted network. Revocation closes the local connection immediately.

The PeerJS signaling service is part of the trust boundary for code pairing. It exchanges SDP, including network addresses, DTLS fingerprints, and ICE credentials, over TLS. A compromised broker can undermine peer identity. It sees connection metadata but receives no filenames, hashes, manifests, history, or media bytes. Do not publish active codes or links. The receiver must remain open. The copy/paste fallback exchanges these descriptions through a trusted channel without contacting PeerJS.

WebRTC encrypts data in transit. SHA-256 verifies that stored bytes match the selected source; it does not establish that a sender, file, or source device is trustworthy. PixelGate does not scan received files or authenticate people. A compromised app build, device, browser extension, hosting account, or signaling exchange can undermine the guarantees.

## Storage and network

Files, manifests, hashes, and history remain local. The app’s static host receives ordinary website requests. PeerJS sees code-pairing connection metadata; STUN sees connection/network information. No TURN media relay or analytics is configured.

Destination paths are validated before file access. Verification flags from remote manifests are ignored. The code-pairing gate validates reliable ordering, protocol metadata, and a nonce-bound approval before handing the channel to the transfer engine. Copy/paste descriptions accept data channels only, have bounded encoded/decompressed sizes, require a matching session/expiry, and reject extra fields. Local persisted records are not an authentication boundary.

OPFS is browser-private storage, not an encrypted vault. Its durability and quota depend on the browser and device. Export and independently verify important copies. Do not treat a browser history record, successful download initiation, or visibility in a photo library or file manager as proof of backup. Confirm backup in the app or service responsible for it.
