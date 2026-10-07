# Architecture

PixelGate 0.3 is a static TypeScript/React application. The UI runs in a browser; hashing and private staging run in dedicated workers. GitHub Pages serves only the application bundle.

## Pairing

The default flow registers a cryptographically generated six-digit receiver ID with PeerJS over TLS WebSockets. Collisions are retried up to eight times. A short QR URL places the code in its fragment; importing it fills the sender’s code input. The sender connects through the broker using a reliable ordered raw data channel and a random connection nonce. No camera or microphone access is requested.

The receiver can approve as soon as a validated signaling request arrives, while route discovery continues. Approval is retained only for that sender and expires if the channel never opens. Opening the channel only enables a bounded approval handler. A file receiver is not installed until the user approves the pending sender. Its nonce-bound approval message precedes the transfer protocol’s automatic hello. Both clients then disconnect from signaling, releasing their IDs without closing the direct channel. Only one sender is accepted. Codes expire after ten minutes, direct connection attempts time out after 45 seconds, registration times out after 15 seconds, and revocation destroys the peer immediately.

The public reference build uses the shared service at `0.peerjs.com`. It sees peer IDs, SDP, ICE candidates, and network information. It does not receive manifests, paths, hashes, history, or file bytes. The application controls its own request/connection bounds but does not operate the shared service’s global rate limits or logs. Production applications can configure their own PeerServer.

Copy/paste pairing remains an optional fallback. The receiver gathers an SDP offer in a versioned, compressed envelope with a random session ID and ten-minute expiry. A URL fragment carries this envelope; the sender copies an answer back. Approval validates kind, session, and expiry before setting the remote description. Bounded, data-channel-only descriptions and fixed-size decompression output prevent unbounded input allocation. This mode does not connect to PeerJS.

WebRTC ICE uses Cloudflare and Google STUN to discover routes. No TURN relay is configured. Browser host-address privacy and network isolation can prevent discovery or a direct connection.

The receiver can optionally supply the sender’s Wi-Fi IPv4 address before creating a code. Only unambiguous unicast dotted IPv4 is accepted; loopback, multicast, unspecified, and link-local destinations are rejected. LAN addresses outside RFC 1918 remain valid, including shared-address networks. A local helper polls the negotiated remote description during connection setup, replacing only UDP application host candidates’ mDNS addresses with that explicit address, preserving their ports, mid, ICE credentials, and DTLS negotiation. At most 32 distinct candidates are tried, with no retries for rejected candidates. Polling stops on activation, failure, or revocation. The helper makes no signaling requests or metadata changes, and the supplied address is not persisted or exported in reports (normal ICE signaling already exchanges network information); reports include only the count of candidates added. Default discovery and receiver approval remain unchanged. This can bypass failed mDNS resolution, but cannot bypass blocked direct traffic or provide IPv6-only connectivity.

## Transfer protocol

The version 1 ordered channel carries JSON controls and binary frames:

| Control                       | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `hello`                       | Negotiate protocol version                                     |
| `start` / `ready`             | Send manifest; reconcile receiver offset or verified duplicate |
| `ack`                         | Confirm a durable checkpoint                                   |
| `finish` / `result`           | Close staging, independently hash it, report verification      |
| `pause` / `resume` / `cancel` | Control the active queue/file                                  |
| `error` / `complete`          | Report failures or completion                                  |

Source hashes are computed incrementally. File IDs hash the source SHA-256 plus relative path. One active transfer uses 16 KiB frames and a 1 MiB receiver checkpoint buffer; one subsequent file hashes ahead. Sender buffering is bounded. Worker flush precedes the IndexedDB checkpoint commit, which precedes acknowledgment.

After reconnect, the sender rehashes selected sources and the receiver owns the resume offset. Unacknowledged tails are truncated to the last stored checkpoint. Missing retained copies are retransferred. Verified destination/staged duplicates are reread before a skip is acknowledged.

## Storage and verification

IndexedDB stores receiver records, sender records, local sessions, and history. OPFS holds partial/staged file bytes; a dedicated worker owns synchronous access handles. The staged file is closed before reread and SHA-256 comparison.

Direct folder saving validates paths, preserves directory structure, detects same-size/same-hash copies, preserves conflicts with numbered filenames, commits on close, and rereads the destination. Manual download initiation does not prove exported integrity; a reselected saved copy must hash-match.

A record’s transfer phase and verification scope are separate. Scopes are `none`, `browser`, `destination`, or `exported`. Integrity failure blocks saving. Permission/quota failure pauses or preserves verified staging for retry.

Internal `pixelbridge` storage/channel identifiers retain the original v1 namespace. Public branding is PixelGate. Because the GitHub deployment has a new origin, existing Sites storage is not migrated.

## Boundaries

No filesystem timestamp restoration, native atomic rename, background service, Android media-scanner control, source deletion, or Google Photos backup verification is included. Browser tabs must remain open. Photos picker output is the source of truth; original Photos-resource retrieval is not guaranteed.

## Local connection diagnostics

Code pairing retains a report of connection states, counts of candidate types and candidate-pair states, and at most 16 STUN service labels/error codes. The probe runs every two seconds while negotiating and stops on connection, revocation, or failure. Raw SDP, IP addresses, peer IDs, pairing codes, error text, and file information are excluded. Reports stay in the current tab; copying one requires an explicit button click and makes no network request.
