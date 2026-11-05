// Mono PCM only. Output is always silence, never microphone monitoring.
class VoiceRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.batch = new Float32Array(2048);
    this.used = 0;
    this.total = 0;
    this.limit = Math.floor(
      sampleRate *
        Math.min(6, Math.max(0, options.processorOptions?.maxSeconds ?? 6)),
    );
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === "stop") this.finish();
      if (data.type === "cancel") {
        this.stopped = true;
        this.batch.fill(0);
        this.used = 0;
      }
    };
  }

  flush() {
    if (!this.used) return;
    const samples = this.batch.slice(0, this.used);
    this.port.postMessage({ type: "samples", samples, sampleRate }, [
      samples.buffer,
    ]);
    this.batch.fill(0);
    this.used = 0;
  }

  finish() {
    if (this.stopped) return;
    this.stopped = true;
    this.flush();
    this.port.postMessage({ type: "done" });
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      if (this.total >= this.limit) {
        this.finish();
        break;
      }
      let mono = 0;
      for (const channel of channels) mono += channel[i] || 0;
      this.batch[this.used++] = mono / channels.length;
      this.total++;
      if (this.used === this.batch.length) this.flush();
    }
    if (this.total >= this.limit) this.finish();
    return !this.stopped;
  }
}

registerProcessor("voice-recorder", VoiceRecorder);
