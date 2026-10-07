# Architecture

PixelGate 0.3 is a static TypeScript/React application. The UI runs in a browser; hashing and private staging run in dedicated workers. GitHub Pages serves only the application bundle.

## Pairing

The default flow registers a cryptographically generated six-digit receiver ID with PeerJS over TLS WebSockets. Collisions are retried up to eight times. A short QR URL places the code in its fragment; importing it fills the sender’s code input. The sender connects through the broker using a reliable ordered raw data channel and a random connection nonce. No camera or microphone access is requested.

The receiver can approve as soon as a validated signaling request arrives, while route discovery continues. Approval is retained only for that sender and expires if the channel never opens. Opening the channel only enables a bounded approval handler. A file receiver is not installed until the user approves the pending sender. Its nonce-bound approval message precedes the transfer protocol’s automatic hello. Both clients then disconnect from signaling, releasing their IDs without closing the direct channel. Only one sender is accepted. Codes expire after ten minutes, direct connection attempts time out after 45 seconds, registration times out after 15 seconds, and revocation destroys the peer immediately.

The public reference build uses the shared service at `0.peerjs.com`. It sees peer IDs, SDP, ICE candidates, and network information. It does not receive manifests, paths, hashes, history, or file bytes. The application controls its own request/connection bounds but does not operate the shared service’s global rate limits or logs. Production applications can configure their own PeerServer.

Copy/paste pairing remains an optional fallback. The receiver gathers an SDP offer in a versioned, compressed envelope with a random session ID and ten-minute expiry. A URL fragment carries this envelope; the sender copies an answer back. Approval validates kind, session, and expiry before setting the remote description. Bounded, data-channel-only descriptions and fixed-size decompression output prevent unbounded input allocation. This mode does not connect to PeerJS.

Incoming trickle ICE candidates are bounded, deduplicated, and held until the remote description is installed. Candidate additions are serialized. A rejected route is recorded by error category and does not abort other candidate attempts. Answer handling wakes the queue; activation, revocation, and failure clear pending candidates and remove its listener. This corrects the pinned PeerJS version's independent ANSWER/CANDIDATE dispatch when candidates overtake their answer. Diagnostics contain only delivery counts and fixed error categories, never candidate strings.

WebRTC ICE uses Cloudflare and Google STUN to discover routes. No TURN relay is configured. Browser host-address privacy and network isolation can prevent discovery or a direct connection.

The receiver can optionally supply the sender’s local IPv4 address before creating a code. Only unambiguous unicast dotted IPv4 is accepted; loopback, multicast, unspecified, and link-local destinations are rejected. LAN addresses outside RFC 1918 remain valid, including shared-address networks. A local helper polls the negotiated remote description during connection setup, replacing only UDP application host candidates’ mDNS addresses with that explicit address, preserving their ports, mid, ICE credentials, and DTLS negotiation. At most 32 distinct candidates are tried, with no retries for rejected candidates. Polling stops on activation, failure, or revocation. The helper makes no signaling requests or metadata changes, and the supplied address is not persisted or exported in reports (normal ICE signaling already exchanges network information); reports include only the count of candidates added. Default discovery and receiver approval remain unchanged. This can bypass failed mDNS resolution, but cannot bypass blocked direct traffic or provide IPv6-only connectivity.

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

IndexedDB stores receiver records, sender records, local sessions, and history. On capable browsers, OPFS holds partial/staged bytes and a dedicated worker owns synchronous access handles. Older browsers use a separate `pixelgate-staging-v1` IndexedDB database with file-length metadata and Blob checkpoints keyed by file ID and byte offset. Each chunk and length commit together in a strict transaction where supported; completion precedes the manifest checkpoint/history transaction and acknowledgment. No bytes are uploaded to a database service.

Preflight writes and rereads a 1 MiB checkpoint. Missing file-system APIs or unsupported synchronous access select compatibility storage; other write/read failures block receiving. Resume reads retained chunks, reconciles the stored manifest offset, and transactionally removes an uncommitted tail, including a partial final chunk. Gaps and invalid sizes are rejected. Readback constructs a File from stored Blobs rather than a file-sized JavaScript ArrayBuffer, then uses the same incremental hash worker. Download, destination readback, exported-copy verification, and clearing verified staging share the storage facade. Retained copies in either backend remain discoverable after browser capability changes.

The writer is closed before actual stored bytes are reread and SHA-256 compared. Browser quota and eviction apply to both backends. These transaction boundaries protect refresh/reconnect recovery; they do not certify OS power-loss durability or large-file behavior on untested hardware.

Direct folder saving validates paths, preserves directory structure, detects same-size/same-hash copies, preserves conflicts with numbered filenames, commits on close, and rereads the destination. Manual download initiation does not prove exported integrity; a reselected saved copy must hash-match.

A record’s transfer phase and verification scope are separate. Scopes are `none`, `browser`, `destination`, or `exported`. Integrity failure blocks saving. Permission/quota failure pauses or preserves verified staging for retry.

Internal `pixelbridge` storage/channel identifiers retain the original v1 namespace. Public branding is PixelGate. Because the GitHub deployment has a new origin, existing Sites storage is not migrated.

## Boundaries

No filesystem timestamp restoration, native atomic rename, background service, native media-scanner control, source deletion, or external backup verification is included. Browser tabs must remain open. Files supplied by the device's picker are the source of truth; retrieval of unmodified originals from photo libraries or cloud services is not guaranteed.

## Local connection diagnostics

Code pairing retains a report of connection states, counts of candidate types and candidate-pair states, and at most 16 STUN service labels/error codes. The probe runs every two seconds while negotiating and stops on connection, revocation, or failure. Raw SDP, IP addresses, peer IDs, pairing codes, error text, and file information are excluded. Reports stay in the current tab; copying one requires an explicit button click and makes no network request.

At the route deadline, the report produces a plain-language explanation distinguishing missing descriptions, candidate rejection, and unsuccessful direct routing. Error 701 from both configured STUN services, combined with no local server-reflexive candidate, is reported as service unreachability. Network isolation is presented as a possibility rather than a confirmed policy. The app cannot read a Wi-Fi SSID or change network routing and access controls.
