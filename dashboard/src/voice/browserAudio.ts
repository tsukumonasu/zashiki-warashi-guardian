/**
 * Browser audio for the voice client: microphone capture through an AudioWorklet and gapless
 * playback of 24 kHz model speech. This is the only module that touches `getUserMedia` and the
 * Web Audio API; `VoiceClient` sees it through the small `AudioIO` interface, so tests use a fake.
 *
 * Create it inside the click handler: browsers start an `AudioContext` only after a user gesture.
 */
import { pcm16ToFloat } from "./audio";
import workletUrl from "./worklet.ts?worker&url";

/** Capture and playback, as the voice client uses them. */
export interface AudioIO {
  /** Asks for the microphone and starts delivering 100 ms chunks of 16 kHz S16 mono. */
  startCapture(onChunk: (pcm: Int16Array) => void): Promise<void>;
  /** Stops the microphone. Safe to call twice. */
  stopCapture(): void;
  /** Schedules 24 kHz S16 mono speech right after the speech already scheduled. */
  play(pcm: Int16Array): void;
  /** Stops every scheduled source at once (barge-in). */
  stopPlayback(): void;
  /** Called with true when speech starts playing and false when the queue runs empty. */
  onPlayback(cb: (playing: boolean) => void): void;
  /** Releases the microphone and the audio context. Safe to call twice. */
  close(): void;
}

export const PLAYBACK_RATE = 24_000;
/** Lead time before the first scheduled chunk, so the start is not clipped. */
const START_LEAD_S = 0.03;

export function createBrowserAudio(): AudioIO {
  const ctx = new AudioContext();
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let nextTime = 0;
  const sources = new Set<AudioBufferSourceNode>();
  let playbackCb: (playing: boolean) => void = () => undefined;
  let closed = false;

  function stopCapture(): void {
    if (node !== null) {
      node.port.onmessage = null;
      node.disconnect();
      node = null;
    }
    source?.disconnect();
    source = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function stopPlayback(): void {
    const was = sources.size > 0;
    for (const s of sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // Not started yet or already stopped.
      }
    }
    sources.clear();
    nextTime = 0;
    if (was) playbackCb(false);
  }

  return {
    async startCapture(onChunk) {
      await ctx.resume();
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (closed) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = media;
      await ctx.audioWorklet.addModule(workletUrl);
      if (closed) return;
      source = ctx.createMediaStreamSource(media);
      node = new AudioWorkletNode(ctx, "warashi-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (ev: MessageEvent<unknown>) => {
        if (ev.data instanceof ArrayBuffer) onChunk(new Int16Array(ev.data));
      };
      source.connect(node);
    },
    stopCapture,
    play(pcm) {
      if (closed || pcm.length === 0) return;
      const samples = pcm16ToFloat(pcm);
      const buffer = ctx.createBuffer(1, samples.length, PLAYBACK_RATE);
      buffer.copyToChannel(new Float32Array(samples), 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime + START_LEAD_S, nextTime);
      nextTime = startAt + buffer.duration;
      src.onended = () => {
        sources.delete(src);
        if (sources.size === 0) playbackCb(false);
      };
      const wasIdle = sources.size === 0;
      sources.add(src);
      src.start(startAt);
      if (wasIdle) playbackCb(true);
    },
    stopPlayback,
    onPlayback(cb) {
      playbackCb = cb;
    },
    close() {
      if (closed) return;
      closed = true;
      stopCapture();
      stopPlayback();
      void ctx.close().catch(() => undefined);
    },
  };
}
