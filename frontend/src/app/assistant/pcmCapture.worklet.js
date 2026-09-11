// The AudioContext runs at 24 kHz. Emit 100 ms PCM16 little-endian mono chunks.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bytes = new ArrayBuffer(4800);
    this.view = new DataView(this.bytes);
    this.offset = 0;
    this.energy = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.energy += sample * sample;
      this.view.setInt16(this.offset * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      if (++this.offset === 2400) {
        this.port.postMessage({ audio: this.bytes, rms: Math.sqrt(this.energy / 2400) }, [this.bytes]);
        this.bytes = new ArrayBuffer(4800);
        this.view = new DataView(this.bytes);
        this.offset = 0;
        this.energy = 0;
      }
    }
    // Outputs remain silent; connecting to destination keeps the worklet active.
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
