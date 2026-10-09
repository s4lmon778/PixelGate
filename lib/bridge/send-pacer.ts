/** Yield to browser packet/UI tasks without nested timers' minimum delay. */
export class SendPacer {
  private channel?: MessageChannel;
  private ready?: () => void;
  async yield(delay: number) {
    if (delay > 0 || typeof MessageChannel === 'undefined') {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, delay)),
      );
      return;
    }
    this.channel ??= new MessageChannel();
    await new Promise<void>((resolve) => {
      this.ready = resolve;
      this.channel!.port1.onmessage = () => {
        this.ready = undefined;
        resolve();
      };
      this.channel!.port2.postMessage(null);
    });
  }
  close() {
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = undefined;
    this.ready?.();
    this.ready = undefined;
  }
}
