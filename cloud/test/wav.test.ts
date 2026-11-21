import { describe, expect, it } from "vitest";
import { pcm16ToWav } from "../lambda/_shared/wav.js";

const text = (b: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...b.slice(start, end));

describe("pcm16ToWav", () => {
  it("writes the header fields of a short buffer", () => {
    const pcm = Uint8Array.from([1, 2, 3, 4]);
    const wav = pcm16ToWav(pcm, 16000);
    const view = new DataView(wav.buffer);
    expect(wav).toHaveLength(48);
    expect(text(wav, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(40);
    expect(text(wav, 8, 16)).toBe("WAVEfmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(wav, 36, 40)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4);
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4]);
  });

  it("wraps empty PCM as a header only, and supports 8 kHz", () => {
    const wav = pcm16ToWav(new Uint8Array(0), 8000);
    expect(wav).toHaveLength(44);
    expect(new DataView(wav.buffer).getUint32(28, true)).toBe(16000);
  });

  it("throws on odd length and on an unsupported rate", () => {
    expect(() => pcm16ToWav(new Uint8Array(3), 16000)).toThrow(RangeError);
    expect(() => pcm16ToWav(new Uint8Array(2), 44100 as unknown as 16000)).toThrow(RangeError);
  });
});
