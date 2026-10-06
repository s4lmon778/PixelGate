# Security policy

PixelGate is experimental. The actively maintained version is the default branch.

## Report a vulnerability

Use **Security → Advisories → Report a vulnerability** on the repository for private reporting when enabled. Do not open a public issue with exploitable details. Include the affected commit, browser/OS, reproduction steps using synthetic data, and impact. There is no guaranteed response time or security certification.

## Trust model

Users load the same trusted app and exchange a temporary receiver link and sender response through a trusted channel. The receiver explicitly approves the response associated with its current offer. One sender is accepted per receiver connection.

Pairing data contains SDP, including network addresses, DTLS fingerprints, and ICE credentials. Treat links and responses as temporary secrets. They expire after ten minutes and are not sent to a pairing server. Revocation closes the local connection; the receiver must remain open to receive.

WebRTC encrypts data in transit. SHA-256 verifies that stored bytes match the selected source; it does not establish that a sender, file, or source device is trustworthy. PixelGate does not scan received files or authenticate people. A compromised app build, device, browser extension, hosting account, or signaling exchange can undermine the guarantees.

## Storage and network

Files, manifests, hashes, and history remain local. The app’s static host receives ordinary website requests. STUN sees connection/network information. No TURN media relay or analytics is configured.

Destination paths are validated before file access. Verification flags from remote manifests are ignored. Pairing descriptions accept data channels only, have bounded encoded/decompressed sizes, require a matching session/expiry, and reject extra fields. Local persisted records are not an authentication boundary.

OPFS is browser-private storage, not an encrypted vault. Its durability and quota depend on the browser and device. Export and independently verify important copies. Do not treat a browser history record, successful download initiation, or Google Photos visibility as proof of backup.
