# Engineering decisions

Design rationale, implementation entry points, and regression evidence for PixelGate. For a runtime reference, see [Architecture](ARCHITECTURE.md).

## 1. Bound the transfer pipeline and apply backpressure

The versioned `Control` discriminated union separates JSON control messages from binary file frames. A `hello` handshake precedes manifests and payloads; the sender validates receiver offsets and checkpoint acknowledgments before advancing.

| Mechanism           | Current behavior                                                                                                                                                                                                                               | Reason                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| File concurrency    | One active transfer; one subsequent file hashes ahead                                                                                                                                                                                          | Overlap preparation with transfer while limiting payload work                       |
| Source reads        | One current 1 MiB checkpoint and at most one checkpoint read ahead                                                                                                                                                                             | Overlap file I/O with network delivery without file-sized buffers                   |
| Hashing reads       | Incremental 1 MiB slices in a worker                                                                                                                                                                                                           | Hash large sources without allocating the entire file on the UI thread              |
| Transport frames    | 16 KiB; negotiated 64 KiB messages on healthy paths                                                                                                                                                                                            | Bound each data-channel message and validate incoming frame sizes                   |
| Sender backpressure | Event-driven refill; new peers grow 512 KiB–2 MiB of credit from timely receipts; 64–256 KiB bursts yield via MessageChannel after warmup; delayed delivery shrinks credit to 128–512 KiB and restores 4 ms pacing; legacy peers retain 64 KiB | Avoid flooding native queues while keeping network delivery and storage overlapped  |
| Durable checkpoints | Up to 1 MiB; up to four outstanding checkpoints when parallel transport is active                                                                                                                                                              | Bound unacknowledged payload while avoiding a round-trip stop after each checkpoint |
| Receiver dispatch   | Serialized processing; at most 4 MiB of queued binary payload and 288 messages                                                                                                                                                                 | Preserve storage order and bound queued work                                        |
| Parallel transport  | Original connection plus up to four independent peers; selective receipts, ordered reassembly, bounded gap recovery and slow-lane cooldown                                                                                                     | Reduce dependence on one SCTP congestion window without changing the storage engine |

These bounds concern payload processing, not total browser memory: queue metadata, runtime overhead, and browser-managed buffers still consume resources. Throughput depends on hashing, storage, the browser, and the network; the repository does not claim an unmeasured performance target.

The transport borrows the sequence-and-reassembly pattern used by [Multipath TCP](https://www.rfc-editor.org/rfc/rfc8684.html#section-3.3.1) and piece-based transfers such as [BitTorrent](https://www.bittorrent.org/beps/bep_0003.html). Additional channels on the same peer connection would share SCTP congestion state, so bulk lanes use separate peer connections. Browser WebRTC does not provide SCTP multihoming ([RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html#section-5)); parallel connections can still use the same physical network. The raw version 1 protocol remains the fallback for older peers and failed lane setup.

Healthy pacing uses [MessageChannel tasks](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel) to service browser work without a fixed timer delay between bursts. Ports are created lazily and closed after each file attempt. Delivery credit stays bounded; receipt delay shrinks it on congested paths and restarts warmup.

Transport acknowledgments release retransmission buffers only. Durable ACKs still follow write/flush and manifest commit, and complete-file readback still decides verification. After a failed checkpoint, queued payload is discarded until the next ordered manifest, without repeating the same error for every in-flight frame. A metadata failure retains the previous committed offset even if its byte tail reached storage; resume truncates that tail.

**Code:** [protocol types and constants](../lib/bridge/model.ts), [sender/receiver engine](../lib/bridge/transfer.ts), [parallel transport](../lib/bridge/striped-channel.ts), [incremental hash worker](../lib/bridge/hash.worker.ts), [controlled browser throughput/failure fixture](../tests/browser/throughput.spec.ts).

## 2. Acknowledge persisted progress, not just received bytes

Checkpoint acknowledgment follows this order on browsers with synchronous OPFS:

```text
OPFS write -> access-handle flush -> IndexedDB transaction commit -> ACK(offset)
```

OPFS and IndexedDB are separate persistence systems, not a single atomic transaction. Writing bytes before committing metadata allows recovery to truncate an uncommitted tail to the last retained checkpoint. On reconnection, the sender reselects and rehashes its sources; the receiver checks the retained staged file and supplies the resume offset. Missing partials or files shorter than the committed offset restart instead of trusting a history entry. Complete-file readback still determines final integrity.

Browsers with unavailable OPFS use a capability-selected IndexedDB fallback. The staging worker commits each checkpoint and its stored byte length in one transaction, requesting `strict` durability when supported. Blob checkpoints are preferred; if the browser rejects Blob cloning, the failed transaction must abort before one retry using an ArrayBuffer of at most 1 MiB. Quota and permission errors are not retried as format changes. Both formats are readable without a database migration. Only after that transaction completes does the receiver commit the manifest offset/history and acknowledge it. The byte store is separate from manifest history; reconnection removes uncommitted tails in a transaction and rejects missing or noncontiguous chunks. Readback wraps each stored buffer as a Blob before retaining it, constructs a File from those Blob references, then hashes 1 MiB slices; the application does not concatenate a whole file into a JavaScript byte array. Browser memory use and quota still require device testing.

OPFS writes must return an integer count between one and the remaining buffer length. Valid short writes advance the offset; flush must leave the file at the expected checkpoint end. This catches native failures represented as impossible unsigned counts before acknowledging progress. The previous durable prefix remains resumable.

Preflight writes and independently rereads a full 1 MiB checkpoint before registering a receiver. An absent or unsupported file-system API, or a context-level OPFS UnknownError or SecurityError, triggers an independently tested compatibility backend. Quota, lock, and readback failures do not switch backends; failed compatibility preflight blocks receiving. Existing staged copies are found in either backend, including after a browser upgrade. Downloads and reselected-export verification work with both storage modes.

File identity is derived from content and path:

```text
fileId = SHA-256(UTF-8(sourceSha256 + "\n" + relativePath))
```

Changed source bytes receive a different identity. A retained verified file is skipped only after its stored bytes are reread and match. Receiver file records and their corresponding history entries are written in the same IndexedDB transaction.

**Code:** [identity derivation](../lib/bridge/hash.ts), [staging worker](../lib/bridge/staging.worker.ts), [chunk storage](../lib/bridge/indexed-staging.ts), [manifest transactions](../lib/bridge/database.ts). **Regression evidence:** [interruption and resume tests](../tests/transfer.test.ts), [real IndexedDB recovery and quota tests](../tests/browser/indexed-staging.spec.ts).

## 3. Model integrity as a property of a specific copy

`RecordFile` separates transfer `phase` from verification `scope`: `none`, `browser`, `destination`, or `exported`. Receiving all bytes is not enough to mark a copy verified.

- **Browser scope:** flush and close the staged file, reread its actual bytes, and compare size and SHA-256 against the source manifest. A mismatch removes the invalid staged copy and blocks saving.
- **Destination scope:** revalidate staged bytes, copy them through a destination writer, close it, and independently hash the saved file. A destination failure retains verified staging for retry.
- **Exported scope:** download initiation leaves verification pending. A reselected saved file must match before the exported copy is marked verified.

Native app handoff prepares `File` objects from staged Blobs after a fresh size/SHA-256 check, without a file-sized JavaScript buffer. Preparation and sharing use separate taps so a long hash does not consume the Web Share API's transient user activation. When available, `navigator.canShare({files})` probes the prepared payload before `navigator.share({files})` is invoked directly in the click handler. Browsers without the optional probe can attempt native sharing; unsupported payloads retain a verified-download fallback. Cancellation and unsupported payloads retain staging. A successful API result sets local `shared` metadata, never destination verification; reports explicitly distinguish the handoff from the saved-copy check. Selections can span the whole collection. Preparation and list rendering use batches/pages of fifty; Download all selected checks and requests successive batches automatically. Requests are spaced by 200 ms because an instant burst dropped downloads in real Chromium tests. Native handoffs use at most ten compatible files per fresh tap; a conservative 50 MiB per-file Android guard avoids Chromium’s native Blob receiver rejection. Larger originals remain unchanged and downloadable for Google Photos device-folder import.

Android Chrome 132 added read/write directory access. The Photos folder action grants access from a fresh tap, streams the entire verified collection into one user-selected local folder, closes and independently hashes every destination, and uses that folder for subsequent incoming files in the same tab. Source directories are flattened only in this explicit mode, retaining original filenames with collision-safe numbering. Native share limits do not apply to directory writes. Android provider support, Photos indexing, account settings, and backup completion still require physical-device validation. This path keeps the originals local for backup by the eligible Pixel Photos app and does not use the quota-consuming Google Photos upload API.

History clearing targets only the IndexedDB `history` store, in one transaction. Session clearing uses a cursor rather than deleting receiver manifests or staging chunks; interruption recovery does not depend on the presentation log.

Incoming manifests cannot assign their own verification status: receiver validation resets phase, scope, offsets, and destination state. Existing destination files are skipped only after size/hash readback; conflicting content receives a numbered filename. Relative paths reject traversal, absolute paths, control characters, and ambiguous separators before filesystem access.

**Code:** [record validation](../lib/bridge/model.ts), [saving and readback](../lib/bridge/storage.ts). **Regression evidence:** [corruption and path tests](../tests/core.test.ts), [destination/export tests](../tests/storage.test.ts).

## 4. Make asynchronous connection failures reproducible

An ICE candidate can arrive before the peer's remote description is installed. In PeerJS 1.5.5, independently dispatched `ANSWER` and `CANDIDATE` messages could cause an early `addIceCandidate()` rejection to abort negotiation.

The per-connection `CandidateInbox` queues candidates until SDP is ready, deduplicates them, serializes additions, and accepts at most 64 distinct candidates. An unusable route records a fixed error category while subsequent routes continue. Activation, failure, and revocation clear queued work and remove listeners.

A browser fixture deliberately delivers candidates before the answer. It reproduced the 0.3.3 failure (`have-local-offer`, missing remote description), then verified that the corrected flow connects, transfers hash-checked bytes, and consumes the code in Chromium, Firefox, and WebKit-to-Chromium. This is a regression for a specific race, not a claim that every network failure is recoverable.

**Code:** [candidate queue](../lib/bridge/candidate-inbox.ts), [PeerJS integration](../lib/bridge/code-connection.ts). **Regression evidence:** [queue lifecycle tests](../tests/candidate-inbox.test.ts), [browser fault injection](../tests/browser/bridge.spec.ts), [baseline reproduction](VALIDATION.md).

## 5. Keep trust boundaries and resource limits explicit

Code pairing validates protocol metadata and reliable ordering, admits one sender, and gates the transfer engine behind receiver consent and a connection-bound nonce. Registration retries, inbound pairing requests, route attempts, and candidate queues are bounded. Codes expire after ten minutes; route setup times out after 45 seconds; revocation destroys the local peer.

The copy/paste fallback uses a versioned compressed SDP envelope with matching session/expiry checks, bounded token length, a fixed decompression output buffer, and data-channel-only SDP validation. Only connection descriptions are compressed; media bytes remain untouched.

A Content Security Policy constrains scripts, workers, and signaling origins. Local diagnostics retain connection states, candidate counts, statistics-read outcomes, and fixed error categories; they exclude raw SDP, IP addresses, codes, filenames, and error text. No analytics or automatic diagnostics upload is configured.

The signaling broker is a trust dependency. A six-digit code and SHA-256 do not authenticate a person, and local browser storage is not an encrypted vault. Application-side bounds do not provide global rate limiting for the public PeerJS service. See [Security](../SECURITY.md) for the full threat model.

**Code:** [pairing envelope](../lib/bridge/pairing.ts), [SDP validation](../lib/pairing-validation.ts), [privacy-limited diagnostics](../lib/bridge/route-diagnostics.ts), [CSP](../index.html).

[Project overview](../README.md) · [Validation record](VALIDATION.md)
