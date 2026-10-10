import type { BrowserContext } from '@playwright/test';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { lookup } from 'node:dns/promises';

type Endpoint = {
  socket?: dgram.Socket;
  address?: string;
  port?: number;
  remote?: string;
  ready?: Promise<void>;
};

/** Delay only the test's ICE/DTLS/SCTP UDP packets; never change system routing. */
export class UdpImpairment {
  private peers = new Map<string, Endpoint>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  forwardedBytes = 0;
  private closed = false;
  constructor(private delayMs: number) {}

  async install(context: BrowserContext) {
    await context.exposeFunction(
      'relayLink',
      (local: string, remote: string) => {
        if (!local || this.closed) return;
        const peer = this.peers.get(local) ?? {};
        if (remote) peer.remote = remote;
        this.peers.set(local, peer);
      },
    );
    await context.exposeFunction(
      'relayCandidate',
      async (ufrag: string, candidate: string) => {
        if (this.closed) return '';
        const fields = candidate.replace(/^a=/, '').split(' ');
        if (fields[2]?.toLowerCase() !== 'udp' || fields[4].includes(':'))
          return '';
        const peer = this.peers.get(ufrag) ?? {};
        this.peers.set(ufrag, peer);
        peer.ready ??= (async () => {
          const address = (await lookup(fields[4], { family: 4 })).address;
          if (this.closed) return;
          const socket = dgram.createSocket('udp4');
          peer.socket = socket;
          peer.address = address;
          peer.port = Number(fields[5]);
          await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(0, address, resolve);
          });
          socket.on('message', (message, source) => {
            const remote = this.peers.get(peer.remote ?? '');
            if (!remote?.socket || source.port !== remote.port) return;
            const timer = setTimeout(() => {
              this.timers.delete(timer);
              if (!remote.socket || !peer.address || !peer.port) return;
              this.forwardedBytes += message.byteLength;
              remote.socket.send(message, peer.port, peer.address);
            }, this.delayMs);
            this.timers.add(timer);
          });
        })();
        await peer.ready;
        if (this.closed || !peer.socket) return '';
        fields[4] = peer.address!;
        fields[5] = String((peer.socket!.address() as AddressInfo).port);
        return fields.join(' ');
      },
    );
    await context.addInitScript(() => {
      type RelayWindow = Window & {
        relayLink: (local: string, remote: string) => Promise<void>;
        relayCandidate: (ufrag: string, candidate: string) => Promise<string>;
      };
      const relay = window as unknown as RelayWindow;
      const Native = RTCPeerConnection;
      const ufrag = (sdp = '') => /a=ice-ufrag:([^\r\n]+)/.exec(sdp)?.[1] ?? '';
      window.RTCPeerConnection = class extends Native {
        private remoteUfrag = '';
        constructor(configuration?: RTCConfiguration) {
          super({ ...configuration, iceServers: [] });
        }
        async setLocalDescription(
          description?: RTCLocalSessionDescriptionInit,
        ) {
          await super.setLocalDescription(description);
          await relay.relayLink(
            ufrag(this.localDescription?.sdp),
            this.remoteUfrag,
          );
        }
        async setRemoteDescription(description: RTCSessionDescriptionInit) {
          this.remoteUfrag = ufrag(description.sdp);
          await relay.relayLink(
            ufrag(this.localDescription?.sdp),
            this.remoteUfrag,
          );
          const lines = await Promise.all(
            (description.sdp ?? '').split('\r\n').map(async (line) => {
              if (!line.startsWith('a=candidate:')) return line;
              const candidate = await relay.relayCandidate(
                this.remoteUfrag,
                line,
              );
              return candidate ? `a=${candidate}` : '';
            }),
          );
          await super.setRemoteDescription({
            ...description,
            sdp: lines.join('\r\n'),
          });
        }
        async addIceCandidate(candidate?: RTCIceCandidateInit | null) {
          if (!candidate?.candidate) return super.addIceCandidate(candidate);
          const value = await relay.relayCandidate(
            this.remoteUfrag,
            candidate.candidate,
          );
          if (value)
            await super.addIceCandidate({ ...candidate, candidate: value });
        }
      };
    });
  }

  close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const peer of this.peers.values()) {
      peer.socket?.close();
      peer.socket = undefined;
    }
    this.timers.clear();
    this.peers.clear();
  }
}
