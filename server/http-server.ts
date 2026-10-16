import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const TTL = 10 * 60_000;
const MAX_BODY = 1024 * 1024;
const MAX_PENDING = 8;
type Upload = {
  req: IncomingMessage;
  res: ServerResponse;
  size: number;
  kind: number;
};
type Endpoint = {
  token: string;
  stream?: ServerResponse;
  next: number;
  pending: Map<number, Upload>;
  pumping: boolean;
};
type Room = {
  id: string;
  code: string;
  expires: number;
  touched: number;
  approved: boolean;
  receiver: Endpoint;
  sender?: Endpoint;
  closed: boolean;
};
type Options = {
  staticDir: string;
  key?: Buffer;
  cert?: Buffer;
  allowedHosts?: string[];
  pairingTTL?: number;
};
const endpoint = (): Endpoint => ({
  token: randomBytes(32).toString('hex'),
  next: 0,
  pending: new Map(),
  pumping: false,
});
const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};

/** A LAN-only streaming bridge. No file payload is retained on disk or collected in RAM. */
export function createSpeedGateServer(options: Options) {
  if (!!options.key !== !!options.cert)
    throw new Error('Supply both TLS key and certificate.');
  const secure = !!options.key;
  const rooms = new Map<string, Room>();
  const codes = new Map<string, Room>();
  const attempts = new Map<string, { count: number; reset: number }>();
  const hosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...Object.values(networkInterfaces()).flatMap(
      (entries) =>
        entries?.map((entry) =>
          entry.family === 'IPv6' ? `[${entry.address}]` : entry.address,
        ) ?? [],
    ),
    ...(options.allowedHosts ?? []),
  ]);
  const root = realpathSync(resolve(options.staticDir));
  const sockets = new Set<import('node:net').Socket>();

  function closeRoom(room: Room) {
    if (room.closed) return;
    room.closed = true;
    rooms.delete(room.id);
    codes.delete(room.code);
    for (const side of [room.receiver, room.sender]) {
      side?.stream?.destroy();
      for (const upload of side?.pending.values() ?? []) {
        upload.res.destroy();
        upload.req.destroy();
      }
      side?.pending.clear();
    }
  }
  const sweep = setInterval(() => {
    for (const room of rooms.values())
      if (
        (!room.approved && room.expires <= Date.now()) ||
        room.touched + 24 * 60 * 60_000 <= Date.now()
      )
        closeRoom(room);
    for (const [ip, value] of attempts)
      if (value.reset <= Date.now()) attempts.delete(ip);
  }, 1000).unref();

  async function json(req: IncomingMessage) {
    let text = '';
    for await (const chunk of req) {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > 1024) fail(413, 'Request too large.');
    }
    try {
      return JSON.parse(text);
    } catch {
      fail(400, 'Invalid JSON.');
    }
  }
  function send(res: ServerResponse, status: number, value?: object) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(value ? JSON.stringify(value) : undefined);
  }
  async function write(stream: ServerResponse, bytes: Uint8Array) {
    if (stream.destroyed) throw new Error('Peer disconnected.');
    if (!stream.write(bytes))
      await new Promise<void>((resolve, reject) => {
        const clean = () => {
          stream.off('drain', drained);
          stream.off('close', closed);
          stream.off('error', closed);
        };
        const drained = () => {
          clean();
          resolve();
        };
        const closed = () => {
          clean();
          reject(new Error('Peer disconnected.'));
        };
        stream.once('drain', drained);
        stream.once('close', closed);
        stream.once('error', closed);
        if (stream.destroyed) closed();
      });
  }
  async function pump(room: Room, side: Endpoint, target?: Endpoint) {
    if (side.pumping || !target?.stream || room.closed) return;
    side.pumping = true;
    try {
      while (!room.closed) {
        const upload = side.pending.get(side.next);
        if (!upload) break;
        const header = Buffer.alloc(5);
        header[0] = upload.kind;
        header.writeUInt32BE(upload.size, 1);
        await write(target.stream, header);
        let bytes = 0;
        for await (const chunk of upload.req) {
          bytes += chunk.length;
          if (bytes > upload.size)
            throw new Error('Body exceeds declared size.');
          await write(target.stream, chunk);
        }
        if (bytes !== upload.size) throw new Error('Truncated request.');
        side.pending.delete(side.next++);
        room.touched = Date.now();
        send(upload.res, 204);
      }
    } catch {
      closeRoom(room);
    } finally {
      side.pumping = false;
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const url = new URL(
      req.url ?? '/',
      `${secure ? 'https' : 'http'}://${req.headers.host}`,
    );
    if (!hosts.has(url.hostname) || req.headers.host !== url.host)
      fail(403, 'Unrecognized host.');
    if (req.headers.origin && req.headers.origin !== url.origin)
      fail(403, 'Use the same SpeedGate origin.');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      fail(403, 'Cross-site requests are not allowed.');
    // Plain HTTP LAN pages cannot use the existing secure-context storage/hash features.
    if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      fail(
        403,
        'LAN access requires trusted HTTPS. Configure SPEEDGATE_TLS_KEY and SPEEDGATE_TLS_CERT.',
      );
    if (url.pathname === '/api/speedgate/v1/info' && req.method === 'GET') {
      send(res, 200, {
        protocol: 'speedgate-http-v1',
        maxFrameBytes: MAX_BODY,
        maxParallel: 4,
        secure,
      });
      return;
    }
    if (url.pathname === '/api/speedgate/v1/rooms' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      let rate = attempts.get(ip);
      if (!rate || rate.reset <= Date.now()) {
        if (attempts.size >= 1024) fail(429, 'Pairing capacity reached.');
        attempts.set(ip, (rate = { count: 0, reset: Date.now() + 60_000 }));
      }
      if (++rate.count > 20)
        fail(429, 'Too many pairing attempts. Wait one minute.');
      const input = await json(req);
      if (!input || typeof input !== 'object')
        fail(400, 'Invalid pairing request.');
      let room: Room;
      let side: Endpoint;
      if (input.role === 'receive') {
        if (rooms.size >= 32) fail(429, 'Too many active receivers.');
        let code: string;
        do {
          code = randomInt(1_000_000).toString().padStart(6, '0');
        } while (codes.has(code));
        room = {
          id: randomUUID(),
          code,
          expires: Date.now() + (options.pairingTTL ?? TTL),
          touched: Date.now(),
          approved: false,
          receiver: endpoint(),
          closed: false,
        };
        rooms.set(room.id, room);
        codes.set(code, room);
        side = room.receiver;
      } else if (input.role === 'send' && /^\d{6}$/.test(input.code)) {
        room =
          codes.get(input.code) ?? fail(404, 'Code unavailable or expired.');
        if (room.expires <= Date.now() || room.sender)
          fail(409, 'Code expired or already used.');
        side = room.sender = endpoint();
      } else return fail(400, 'Invalid pairing request.');
      send(res, 201, {
        id: room.id,
        code: room.code,
        expires: room.expires,
        token: side.token,
      });
      return;
    }
    const match =
      /^\/api\/speedgate\/v1\/rooms\/([a-f0-9-]{36})\/(state|approve|stream|message|close)$/.exec(
        url.pathname,
      );
    if (match) {
      const room =
        rooms.get(match[1]) ??
        fail(404, 'Connection ended. Reconnect to resume.');
      if (!room.approved && room.expires <= Date.now()) {
        closeRoom(room);
        fail(410, 'Pairing expired.');
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const side =
        token === room.receiver.token
          ? room.receiver
          : room.sender && token === room.sender.token
            ? room.sender
            : fail(403, 'Invalid session token.');
      const target = side === room.receiver ? room.sender : room.receiver;
      room.touched = Date.now();
      const action = match[2];
      if (action === 'state' && req.method === 'GET') {
        send(res, 200, { pending: !!room.sender, approved: room.approved });
        return;
      }
      if (action === 'close' && req.method === 'POST') {
        send(res, 204);
        closeRoom(room);
        return;
      }
      if (action === 'approve' && req.method === 'POST') {
        if (side !== room.receiver || !room.sender || room.approved)
          fail(409, 'No sender awaiting approval.');
        room.approved = true;
        codes.delete(room.code);
        send(res, 204);
        return;
      }
      if (!room.approved) fail(403, 'Receiver approval required.');
      if (action === 'stream' && req.method === 'GET') {
        if (side.stream) fail(409, 'A stream is already open.');
        side.stream = res;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.on('close', () => closeRoom(room));
        void pump(room, target!, side);
        return;
      }
      if (action === 'message' && req.method === 'POST') {
        const sequence = Number(url.searchParams.get('sequence'));
        const kind = Number(req.headers['x-speedgate-kind']);
        const size = Number(req.headers['content-length']);
        if (
          !url.searchParams.has('sequence') ||
          !Number.isSafeInteger(sequence) ||
          sequence < side.next ||
          sequence >= side.next + MAX_PENDING ||
          side.pending.has(sequence)
        )
          fail(409, 'Invalid message sequence.');
        if (
          ![0, 1, 2].includes(kind) ||
          !Number.isSafeInteger(size) ||
          size < 1 ||
          size > (kind === 0 ? 12000 : MAX_BODY)
        )
          fail(413, 'Invalid message size or type.');
        if (side.pending.size >= MAX_PENDING)
          fail(429, 'Upload window exceeded.');
        req.pause();
        side.pending.set(sequence, { req, res, size, kind });
        req.on('aborted', () => closeRoom(room));
        res.on('close', () => {
          if (!res.writableFinished) closeRoom(room);
        });
        void pump(room, side, target);
        return;
      }
      fail(405, 'Unsupported operation.');
    }
    if (url.pathname.startsWith('/api/')) fail(404, 'Unknown API endpoint.');
    if (req.method !== 'GET' && req.method !== 'HEAD')
      fail(405, 'Method not allowed.');
    const pathname = decodeURIComponent(url.pathname);
    const path = await realpath(
      resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)),
    ).catch(() => fail(404, 'File not found.'));
    if (!path.startsWith(root + sep)) fail(403, 'Invalid asset path.');
    const info = await stat(path);
    if (!info.isFile()) fail(404, 'File not found.');
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
    };
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else
      createReadStream(path)
        .on('error', () => res.destroy())
        .pipe(res);
  }
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) res.destroy();
      else
        send(res, error.status ?? 500, {
          error: error.status ? error.message : 'Local server error.',
        });
      // Discard rejected bodies without buffering, allowing clients to receive
      // the error response instead of a write-side reset.
      if (!req.complete) {
        req.setTimeout(5000, () => req.destroy());
        req.resume();
      }
    });
  };
  const server = secure
    ? httpsServer(
        { key: options.key, cert: options.cert, minVersion: 'TLSv1.2' },
        listener,
      )
    : httpServer(listener);
  server.requestTimeout = 0; // Large uploads are credit bounded; not limited by whole-file time.
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 60_000;
  server.maxConnections = 128;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('close', () => clearInterval(sweep));
  return {
    server,
    close: async () => {
      clearInterval(sweep);
      for (const room of rooms.values()) closeRoom(room);
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
