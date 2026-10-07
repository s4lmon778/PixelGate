import { decodePair, encodePair, PAIR_TTL, type PairSignal } from './pairing';
import type { RouteDiagnostics } from './route-diagnostics';
export interface PairRoom {
  id: string;
  expires: number;
  offer?: string;
  response?: string;
  code?: string;
  pending?: boolean;
  routeReady?: boolean;
  approvalGranted?: boolean;
  failed?: boolean;
  diagnostics?: RouteDiagnostics;
}

export class Connection {
  room?: PairRoom;
  pc?: RTCPeerConnection;
  channel?: RTCDataChannel;
  private timeout?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private answered = false;
  constructor(
    private role: 'send' | 'receive',
    private events: {
      room: (r: PairRoom) => void;
      status: (s: string) => void;
      connected: (channel: RTCDataChannel) => void;
      error: (e: Error) => void;
    },
  ) {}
  private setup(expires: number) {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });
    this.pc.onconnectionstatechange = () => {
      if (this.stopped) return;
      if (this.pc?.connectionState === 'failed')
        this.events.error(
          new Error(
            'Could not connect directly. Use the same Wi-Fi and check guest-network or VPN isolation.',
          ),
        );
      else if (this.pc?.connectionState === 'disconnected')
        this.events.error(
          new Error(
            'Connection interrupted. Reconnect and reselect the same files to resume.',
          ),
        );
    };
    this.pc.ondatachannel = (e) => {
      if (this.channel) {
        e.channel.close();
        return;
      }
      this.attach(e.channel);
    };
    this.timeout = setTimeout(
      () => {
        if (!this.stopped && this.channel?.readyState !== 'open') {
          this.events.error(
            new Error('Pairing expired. Create a new receiver link.'),
          );
          void this.stop();
        }
      },
      Math.max(0, expires - Date.now()),
    );
  }
  private attach(channel: RTCDataChannel) {
    if (
      channel.label !== 'pixelbridge-v1' ||
      !channel.ordered ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      this.events.error(
        new Error('A reliable ordered PixelGate channel is required.'),
      );
      return;
    }
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (this.stopped) return;
      clearTimeout(this.timeout);
      this.events.status('Connected');
      this.events.connected(channel);
    };
    channel.onclose = () => {
      if (!this.stopped)
        this.events.error(new Error('Connection closed. Reconnect to resume.'));
    };
    channel.onerror = () => {
      if (!this.stopped)
        this.events.error(
          new Error('The peer connection encountered an error.'),
        );
    };
  }
  private async gathered() {
    const pc = this.pc!;
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', changed);
      };
      const changed = () => {
        if (pc.iceGatheringState === 'complete') {
          finish();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish();
        if (!this.stopped && pc.localDescription?.sdp.includes('a=candidate:'))
          resolve();
        else
          reject(
            new Error(
              'No direct network route was discovered. Check Wi-Fi isolation, VPN settings, or try another browser.',
            ),
          );
      }, 10000);
      pc.addEventListener('icegatheringstatechange', changed);
    });
    if (this.stopped) throw new Error('Connection was revoked.');
  }
  async start(input?: string) {
    if (this.role === 'receive') {
      const id = crypto.randomUUID(),
        expires = Date.now() + PAIR_TTL;
      this.events.status('Preparing receiver link…');
      this.setup(expires);
      this.attach(
        this.pc!.createDataChannel('pixelbridge-v1', { ordered: true }),
      );
      await this.pc!.setLocalDescription(await this.pc!.createOffer());
      await this.gathered();
      this.room = { id, expires, offer: this.describe(id, expires) };
      this.events.room(this.room);
      this.events.status('Waiting for sender response');
    } else {
      const offer = decodePair(input ?? '', 'offer');
      this.events.status('Preparing sender response…');
      this.setup(offer.expires);
      await this.pc!.setRemoteDescription(offer.description);
      await this.pc!.setLocalDescription(await this.pc!.createAnswer());
      await this.gathered();
      this.room = {
        id: offer.id,
        expires: offer.expires,
        response: this.describe(offer.id, offer.expires),
      };
      this.events.room(this.room);
      this.events.status('Waiting for receiver approval');
    }
  }
  private describe(id: string, expires: number) {
    const description = this.pc!.localDescription!;
    return encodePair({
      version: 1,
      id,
      expires,
      description: { type: description.type, sdp: description.sdp },
    } as PairSignal);
  }
  async approve(input: string) {
    if (this.role !== 'receive' || !this.room || !this.pc || this.stopped)
      throw new Error('Create a receiver link first.');
    if (this.answered)
      throw new Error(
        'This receiver already approved a sender. Revoke it before pairing again.',
      );
    const answer = decodePair(input, 'answer');
    if (answer.id !== this.room.id || answer.expires !== this.room.expires)
      throw new Error('This response belongs to another receiver link.');
    await this.pc.setRemoteDescription(answer.description);
    this.answered = true;
    this.events.status('Connecting…');
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timeout);
    this.channel?.close();
    this.pc?.close();
  }
}
