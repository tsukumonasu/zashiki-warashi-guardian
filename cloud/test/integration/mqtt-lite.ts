// Minimal MQTT 3.1.1 client over mutual TLS, for the opt-in integration test only.
//
// Why: the IoT data plane API can publish but cannot subscribe, and the test must read the
// `judgement.result` the way the doll does. The repository has no MQTT library on the cloud side
// and the test needs only CONNECT, SUBSCRIBE, PUBLISH (QoS 1) and PUBACK, so this stays a small
// file instead of a new dependency. Not used by any Lambda.
import tls from "node:tls";

export interface MqttLiteOptions {
  host: string;
  clientId: string;
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  port?: number;
  timeoutMs?: number;
}

type Waiter = (body: Buffer) => void;

function encodeLength(n: number): Buffer {
  const out: number[] = [];
  let x = n;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return Buffer.from(out);
}

function utf8(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(firstByte: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([firstByte]), encodeLength(body.length), body]);
}

export class MqttLite {
  private socket: tls.TLSSocket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly waiters = new Map<string, Waiter>();
  private readonly listeners = new Set<(topic: string, payload: Buffer, receivedAtMs: number) => void>();
  private readonly timeoutMs: number;

  constructor(private readonly options: MqttLiteOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  onMessage(listener: (topic: string, payload: Buffer, receivedAtMs: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    const { host, port = 8883, cert, key, ca } = this.options;
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({ host, port, cert, key, ca, servername: host }, () => resolve());
      socket.once("error", reject);
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      this.socket = socket;
    });
    const connack = this.expect("CONNACK");
    const vh = Buffer.concat([utf8("MQTT"), Buffer.from([4, 0x02, 0x00, 0x1e])]); // clean session, 30 s keep alive
    this.write(packet(0x10, Buffer.concat([vh, utf8(this.options.clientId)])));
    const body = await connack;
    if (body[1] !== 0) throw new Error(`MQTT connection refused, code ${body[1]}`);
  }

  async subscribe(topic: string): Promise<void> {
    const id = this.takeId();
    const suback = this.expect(`SUBACK${id}`);
    const idBuf = Buffer.alloc(2);
    idBuf.writeUInt16BE(id);
    this.write(packet(0x82, Buffer.concat([idBuf, utf8(topic), Buffer.from([1])])));
    const body = await suback;
    if (body[2] === 0x80) throw new Error("MQTT subscription refused (check the IoT policy)");
  }

  /** Publishes with QoS 1 and resolves when the broker acknowledges. */
  async publish(topic: string, payload: string): Promise<void> {
    const id = this.takeId();
    const puback = this.expect(`PUBACK${id}`);
    const idBuf = Buffer.alloc(2);
    idBuf.writeUInt16BE(id);
    this.write(packet(0x32, Buffer.concat([utf8(topic), idBuf, Buffer.from(payload, "utf8")])));
    await puback;
  }

  close(): void {
    if (!this.socket) return;
    try {
      this.write(packet(0xe0, Buffer.alloc(0)));
    } catch {
      // The socket is already gone.
    }
    this.socket.destroy();
    this.socket = undefined;
  }

  private takeId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
    return id;
  }

  private write(data: Buffer): void {
    if (!this.socket) throw new Error("MQTT socket is closed");
    this.socket.write(data);
  }

  private expect(name: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(name);
        reject(new Error(`MQTT timeout waiting for ${name}`));
      }, this.timeoutMs);
      this.waiters.set(name, (body) => {
        clearTimeout(timer);
        this.waiters.delete(name);
        resolve(body);
      });
    });
  }

  private onData(chunk: Buffer): void {
    const receivedAtMs = performance.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      let length = 0;
      let multiplier = 1;
      let i = 1;
      let byte: number;
      do {
        if (i >= this.buffer.length) return;
        byte = this.buffer[i++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
      } while (byte & 0x80);
      if (this.buffer.length < i + length) return;
      const first = this.buffer[0];
      const body = this.buffer.subarray(i, i + length);
      this.buffer = this.buffer.subarray(i + length);
      this.handle(first, Buffer.from(body), receivedAtMs);
    }
  }

  private handle(first: number, body: Buffer, receivedAtMs: number): void {
    const type = first >> 4;
    if (type === 2) this.waiters.get("CONNACK")?.(body);
    else if (type === 4) this.waiters.get(`PUBACK${body.readUInt16BE(0)}`)?.(body);
    else if (type === 9) this.waiters.get(`SUBACK${body.readUInt16BE(0)}`)?.(body);
    else if (type === 3) {
      const topicLength = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + topicLength).toString("utf8");
      let offset = 2 + topicLength;
      const qos = (first >> 1) & 3;
      if (qos > 0) {
        const idBuf = body.subarray(offset, offset + 2);
        offset += 2;
        this.write(packet(0x40, idBuf));
      }
      const payload = body.subarray(offset);
      for (const listener of this.listeners) listener(topic, payload, receivedAtMs);
    }
  }
}
