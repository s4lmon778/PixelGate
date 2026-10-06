import {
  Peer,
  SerializationType,
  type DataConnection,
  type PeerOptions,
} from 'peerjs';
import type { PairRoom } from './connection';
import { PAIR_TTL } from './pairing';

const PREFIX = 'pixelgate-v2-';
const PROTOCOL = 'pixelgate-code-v1';
const CHANNEL = 'pixelbridge-v1';

export function pairingCode(input: string) {
  let code = input.trim();
  if (/^https?:\/\//.test(code))
    code =
      new URLSearchParams(new URL(code).hash.slice(1)).get('connect') ?? '';
  code = code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code))
    throw new Error('Enter the receiver’s six-digit code.');
  return code;
}

export function newPairingCode() {
  // Rejection sampling avoids favoring some codes. Leading zeroes are valid.
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= 4294000000);
  return (value[0] % 1000000).toString().padStart(6, '0');
}

function peerOptions(): PeerOptions {
  const url = new URL(
    import.meta.env.VITE_PIXELGATE_SIGNAL_URL || 'https://0.peerjs.com',
  );
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname)
    )
  )
    throw new Error('The pairing service must use HTTPS.');
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    path: url.pathname,
    secure: url.protocol === 'https:',
    debug: 0,
    token: crypto.randomUUID(),
    referrerPolicy: 'no-referrer',
    config: { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] },
  };
}

type Events = {
  room: (room: PairRoom) => void;
  status: (status: string) => void;
  connected: (channel: RTCDataChannel) => void;
  error: (error: Error) => void;
};

export class CodeConnection {
  room?: PairRoom;
  channel?: RTCDataChannel;
  peer?: Peer;
  private data?: DataConnection;
  private timer?: ReturnType<typeof setTimeout>;
  private routeTimer?: ReturnType<typeof setTimeout>;
  private openingReject?: (error: Error) => void;
  private stopped = false;
  private approved = false;
  private nonce = crypto.randomUUID();
  private requests = 0;

  constructor(
    private role: 'send' | 'receive',
    private events: Events,
  ) {}

  private async register(id: string) {
    const peer = new Peer(id, peerOptions());
    this.peer = peer;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        reject(
          new Error(
            'Pairing service unavailable. Try again or use copy/paste pairing.',
          ),
        );
        peer.destroy();
      }, 15000);
      this.openingReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      peer.on('open', () => {
        clearTimeout(timer);
        this.openingReject = undefined;
        opened = true;
        resolve();
      });
      peer.on('error', (error) => {
        clearTimeout(timer);
        if (!opened) {
          this.openingReject = undefined;
          reject(error);
        } else if (!this.stopped && !this.approved) {
          this.fail(
            new Error(
              error.type === 'peer-unavailable'
                ? 'That code is unavailable, expired, or already used. Check the six digits or create a new connection.'
                : 'Pairing failed. Check your network, then try again or use copy/paste pairing.',
            ),
          );
        }
      });
      peer.on('disconnected', () => {
        if (opened && !this.stopped && !this.approved)
          this.fail(
            new Error(
              'The pairing service disconnected. Create a new connection.',
            ),
          );
      });
    });
    if (this.stopped) {
      peer.destroy();
      throw new Error('Connection was revoked.');
    }
    return peer;
  }

  async start(input = '') {
    this.events.status('Preparing six-digit pairing…');
    if (this.role === 'receive') {
      let code = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        code = newPairingCode();
        try {
          await this.register(PREFIX + code);
          break;
        } catch (error) {
          this.peer?.destroy();
          if (
            (error as { type?: string }).type !== 'unavailable-id' ||
            attempt === 7 ||
            this.stopped
          )
            throw error;
        }
      }
      this.room = {
        id: crypto.randomUUID(),
        expires: Date.now() + PAIR_TTL,
        code,
        offer: code,
        pending: false,
      };
      this.peer!.on('connection', (data) => {
        this.requests++;
        if (
          this.stopped ||
          this.approved ||
          this.data ||
          this.requests > 10 ||
          data.label !== CHANNEL ||
          data.serialization !== SerializationType.None ||
          !data.reliable ||
          Object.keys(data.metadata ?? {}).length !== 2 ||
          data.metadata?.protocol !== PROTOCOL ||
          !/^[a-f0-9-]{36}$/.test(data.metadata?.nonce ?? '')
        ) {
          data.close();
          if (this.requests > 10)
            this.fail(
              new Error('Too many pairing requests. Create a fresh code.'),
            );
          return;
        }
        this.nonce = data.metadata.nonce;
        this.bind(data);
      });
      this.peer!.on('call', (call) => call.close());
      this.events.status('Waiting for sender');
    } else {
      const code = pairingCode(input);
      await this.register('pixelgate-sender-' + crypto.randomUUID());
      this.room = {
        id: crypto.randomUUID(),
        expires: Date.now() + PAIR_TTL,
        code,
      };
      this.peer!.on('connection', (data) => data.close());
      this.peer!.on('call', (call) => call.close());
      this.events.status('Connecting to receiver…');
      this.bind(
        this.peer!.connect(PREFIX + code, {
          label: CHANNEL,
          serialization: SerializationType.None,
          reliable: true,
          metadata: { protocol: PROTOCOL, nonce: this.nonce },
        }),
      );
    }
    this.events.room(this.room);
    this.timer = setTimeout(
      () =>
        this.fail(new Error('Pairing expired. Create a new six-digit code.')),
      PAIR_TTL,
    );
  }

  private bind(data: DataConnection) {
    this.data = data;
    this.routeTimer = setTimeout(
      () =>
        this.fail(
          new Error(
            'Could not connect directly. Use the same Wi-Fi and check guest-network or VPN isolation.',
          ),
        ),
      45000,
    );
    data.on('error', () =>
      this.fail(
        new Error(
          'Could not connect directly. Use the same Wi-Fi and check guest-network or VPN isolation.',
        ),
      ),
    );
    data.on('close', () => {
      if (!this.stopped)
        this.fail(
          new Error(
            'Connection closed or declined. Create a new connection to resume.',
          ),
        );
    });
    data.on('iceStateChanged', (state) => {
      if (state === 'disconnected' && this.approved)
        this.events.error(
          new Error(
            'Connection interrupted. Reconnect and reselect the same files to resume.',
          ),
        );
    });
    data.on('open', () => {
      clearTimeout(this.routeTimer);
      const channel = data.dataChannel;
      if (
        this.stopped ||
        !channel.ordered ||
        channel.maxRetransmits !== null ||
        channel.maxPacketLifeTime !== null
      ) {
        data.close();
        return;
      }
      this.channel = channel;
      channel.binaryType = 'arraybuffer';
      // Nothing can reach the file receiver before explicit approval.
      channel.onmessage = ({ data: message }) => {
        if (
          this.role !== 'send' ||
          typeof message !== 'string' ||
          message.length > 256
        ) {
          this.fail(new Error('Unexpected data before receiver approval.'));
          return;
        }
        try {
          const value = JSON.parse(message);
          if (
            value.type !== 'pixelgate-approved' ||
            value.version !== 1 ||
            value.nonce !== this.nonce ||
            Object.keys(value).length !== 3
          )
            throw new Error('Invalid approval.');
          this.activate();
        } catch {
          this.fail(new Error('Invalid receiver approval.'));
        }
      };
      if (this.role === 'receive') {
        this.room = { ...this.room!, pending: true };
        this.events.room(this.room);
        this.events.status('Sender is waiting for approval');
      } else this.events.status('Waiting for receiver approval');
    });
  }

  async approve(input?: string) {
    if (input?.trim())
      throw new Error('Six-digit pairing does not require a sender response.');
    if (
      this.stopped ||
      this.role !== 'receive' ||
      !this.room?.pending ||
      this.channel?.readyState !== 'open'
    )
      throw new Error(
        'Wait for your sender to connect with the six-digit code.',
      );
    if (this.approved) throw new Error('This code was already used.');
    if (this.room.expires <= Date.now()) {
      this.fail(new Error('Pairing expired.'));
      return;
    }
    // Approval must precede the transfer protocol's automatic hello message.
    // The receiver handler is installed in this same JavaScript turn, before
    // any incoming sender messages can be dispatched.
    this.channel.send(
      JSON.stringify({
        type: 'pixelgate-approved',
        version: 1,
        nonce: this.nonce,
      }),
    );
    this.activate();
  }

  private activate() {
    this.approved = true;
    clearTimeout(this.timer);
    this.events.connected(this.channel!);
    this.events.status('Connected');
    // Release the one-time code without closing the direct data channel.
    this.peer?.disconnect();
  }

  private fail(error: Error) {
    if (this.stopped) return;
    void this.stop();
    this.events.error(error);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.routeTimer);
    this.openingReject?.(new Error('Connection was revoked.'));
    this.openingReject = undefined;
    this.peer?.destroy();
  }
}
