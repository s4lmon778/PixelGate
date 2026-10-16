import type { PairRoom } from './connection';
import {
  HttpChannel,
  httpRequest,
  closeHttpRoom,
  type HttpCredentials,
} from './http-channel';
import { pairingCode } from './code-connection';
import type { RouteDiagnostics } from './route-diagnostics';

function diagnostics(elapsedSeconds = 0): RouteDiagnostics {
  return {
    transport: 'http-tcp',
    elapsedSeconds,
    signaling: 'local-http',
    ice: 'not-applicable',
    gathering: 'not-applicable',
    connection: 'connected',
    channel: 'open',
    localDescription: false,
    remoteDescription: false,
    localCandidates: { host: 0, srflx: 0, prflx: 0, relay: 0 },
    remoteCandidates: { host: 0, srflx: 0, prflx: 0, relay: 0 },
    localMdns: 0,
    remoteMdns: 0,
    lanCandidatesAdded: 0,
    statsReads: 0,
    statsErrors: 0,
    candidatePairs: {},
    stunErrors: [],
    selectedRoute: {
      localType: 'browser',
      remoteType: 'local-helper',
      protocol: location.protocol === 'https:' ? 'https/tcp' : 'http/tcp',
    },
  };
}

type Events = {
  room: (room: PairRoom) => void;
  status: (status: string) => void;
  connected: (channel: HttpChannel) => void;
  error: (error: Error) => void;
};
export async function hasHttpBridge() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await httpRequest('/info', undefined, {
      signal: controller.signal,
    });
    return (await response.json()).protocol === 'speedgate-http-v1';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
export class HttpConnection {
  room?: PairRoom;
  channel?: HttpChannel;
  private credentials?: HttpCredentials;
  private stopped = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private connectedAt = 0;
  constructor(
    private role: 'send' | 'receive',
    private events: Events,
  ) {}
  async start(input = '') {
    if (!isSecureContext)
      throw new Error(
        'Open the LAN bridge using browser-trusted HTTPS. HTTP on LAN addresses cannot support verified browser storage.',
      );
    const response = await httpRequest('/rooms', undefined, {
      method: 'POST',
      signal: this.controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: this.role,
        ...(this.role === 'send' ? { code: pairingCode(input) } : {}),
      }),
    });
    const value = await response.json();
    this.credentials = { id: value.id, token: value.token };
    if (this.stopped) {
      await this.stop();
      return;
    }
    this.room = {
      id: value.id,
      code: value.code,
      offer: value.code,
      expires: value.expires,
      pending: false,
      routeReady: true,
    };
    this.events.room(this.room);
    this.events.status(
      this.role === 'receive'
        ? 'Waiting for sender'
        : 'Waiting for receiver approval',
    );
    void this.poll();
  }
  private async poll() {
    if (this.stopped || !this.credentials) return;
    try {
      const response = await httpRequest(
        `/rooms/${this.credentials.id}/state`,
        this.credentials,
        { signal: this.controller.signal },
      );
      const state = await response.json();
      if (this.stopped) return;
      this.room = {
        ...this.room!,
        pending: state.pending,
        approvalGranted: state.approved,
      };
      this.events.room(this.room);
      if (state.approved) {
        this.channel = new HttpChannel(this.credentials, this.role);
        this.channel.addEventListener('close', () => {
          if (!this.stopped) {
            if (this.room?.diagnostics) {
              this.room = {
                ...this.room,
                failed: true,
                diagnostics: {
                  ...this.room.diagnostics,
                  connection: 'disconnected',
                  channel: 'closed',
                },
              };
              this.events.room(this.room);
            }
            this.events.error(
              new Error(
                'HTTP connection interrupted. Reconnect and reselect the same files to resume.',
              ),
            );
          }
        });
        await this.channel.open();
        if (this.stopped) {
          this.channel.close();
          return;
        }
        this.room = { ...this.room!, diagnostics: diagnostics() };
        this.events.room(this.room);
        this.events.connected(this.channel);
        this.events.status('Connected');
        this.connectedAt = performance.now();
        this.monitor();
      } else this.timer = setTimeout(() => void this.poll(), 400);
    } catch (error) {
      if (!this.stopped) {
        this.events.error(error as Error);
        await this.stop();
      }
    }
  }
  private monitor() {
    // Refresh local snapshots and source-stage publication without polling the
    // helper or reading file data. No ICE/RTT measurement is implied.
    this.timer = setTimeout(() => {
      if (this.stopped || this.channel?.readyState !== 'open' || !this.room)
        return;
      this.room = {
        ...this.room,
        diagnostics: diagnostics(
          Math.round((performance.now() - this.connectedAt) / 1000),
        ),
      };
      this.events.room(this.room);
      this.monitor();
    }, 2000);
  }
  async approve(input = '') {
    if (input) throw new Error('HTTP pairing uses a six-digit code.');
    if (this.role !== 'receive' || !this.credentials || this.stopped)
      throw new Error('Create a receiver first.');
    await httpRequest(
      `/rooms/${this.credentials.id}/approve`,
      this.credentials,
      { method: 'POST', signal: this.controller.signal },
    );
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller.abort();
    this.channel?.close();
    if (this.credentials && !this.channel)
      await closeHttpRoom(this.credentials);
  }
}
