import { TriggerClientEvent, TriggerEvent, TriggerServerEvent } from "./events.ts";
import { expose, side } from "./runtime.ts";
import { isPlain, isVec3 } from "./protocol.ts";

const MAX_DEPTH = 128;
const EXT_VEC2 = 20;
const EXT_VEC3 = 21;
const EXT_VEC4 = 22;
const EXT_QUAT = 23;
const EXT_KEYS: Record<number, readonly string[]> = {
  [EXT_VEC2]: ["x", "y"],
  [EXT_VEC3]: ["x", "y", "z"],
  [EXT_VEC4]: ["x", "y", "z", "w"],
  [EXT_QUAT]: ["x", "y", "z", "w"],
};
const I64_MIN = -(2n ** 63n);
const U64_MAX = 2n ** 64n - 1n;

export type MsgpackInput = ArrayBuffer | ArrayBufferView | string;

function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

class Writer {
  private bytes = new Uint8Array(256);
  private view = new DataView(this.bytes.buffer);
  private length = 0;

  private room(n: number): number {
    const at = this.length;
    if (at + n > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, at + n));
      grown.set(this.bytes);
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = at + n;
    return at;
  }

  u8(value: number): void {
    this.bytes[this.room(1)] = value;
  }

  tag16(tag: number, value: number): void {
    const at = this.room(3);
    this.bytes[at] = tag;
    this.view.setUint16(at + 1, value);
  }

  tag32(tag: number, value: number): void {
    const at = this.room(5);
    this.bytes[at] = tag;
    this.view.setUint32(at + 1, value);
  }

  tagInt(tag: number, size: 1 | 2 | 4, value: number): void {
    const at = this.room(1 + size);
    this.bytes[at] = tag;
    if (size === 1) this.view.setInt8(at + 1, value);
    else if (size === 2) this.view.setInt16(at + 1, value);
    else this.view.setInt32(at + 1, value);
  }

  tagUint(tag: number, size: 1 | 2 | 4, value: number): void {
    const at = this.room(1 + size);
    this.bytes[at] = tag;
    if (size === 1) this.view.setUint8(at + 1, value);
    else if (size === 2) this.view.setUint16(at + 1, value);
    else this.view.setUint32(at + 1, value);
  }

  tag64(tag: number, value: bigint): void {
    const at = this.room(9);
    this.bytes[at] = tag;
    this.view.setBigInt64(at + 1, BigInt.asIntN(64, value));
  }

  float64(value: number): void {
    const at = this.room(9);
    this.bytes[at] = 0xcb;
    this.view.setFloat64(at + 1, value);
  }

  float32le(value: number): void {
    this.view.setFloat32(this.room(4), value, true);
  }

  raw(data: Uint8Array): void {
    this.bytes.set(data, this.room(data.length));
  }

  text(value: string): void {
    const at = this.room(utf8Length(value));
    let p = at;
    for (let i = 0; i < value.length; i++) {
      let c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
        c = 0x10000 + ((c - 0xd800) << 10) + (value.charCodeAt(++i) - 0xdc00);
      }
      if (c < 0x80) this.bytes[p++] = c;
      else if (c < 0x800) {
        this.bytes[p++] = 0xc0 | (c >> 6);
        this.bytes[p++] = 0x80 | (c & 0x3f);
      } else if (c < 0x10000) {
        this.bytes[p++] = 0xe0 | (c >> 12);
        this.bytes[p++] = 0x80 | ((c >> 6) & 0x3f);
        this.bytes[p++] = 0x80 | (c & 0x3f);
      } else {
        this.bytes[p++] = 0xf0 | (c >> 18);
        this.bytes[p++] = 0x80 | ((c >> 12) & 0x3f);
        this.bytes[p++] = 0x80 | ((c >> 6) & 0x3f);
        this.bytes[p++] = 0x80 | (c & 0x3f);
      }
    }
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function packHeader(out: Writer, n: number, fix: number, tag16: number, tag32: number): void {
  if (n <= 15) out.u8(fix + n);
  else if (n <= 0xffff) out.tag16(tag16, n);
  else out.tag32(tag32, n);
}

function packNumber(out: Writer, value: number): void {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) return out.float64(value);
  if (value >= 0) {
    if (value <= 0x7f) out.u8(value);
    else if (value <= 0xff) out.tagUint(0xcc, 1, value);
    else if (value <= 0xffff) out.tagUint(0xcd, 2, value);
    else if (value <= 0xffffffff) out.tagUint(0xce, 4, value);
    else out.tag64(0xcf, BigInt(value));
  } else if (value >= -32) out.u8(value & 0xff);
  else if (value >= -0x80) out.tagInt(0xd0, 1, value);
  else if (value >= -0x8000) out.tagInt(0xd1, 2, value);
  else if (value >= -0x80000000) out.tagInt(0xd2, 4, value);
  else out.tag64(0xd3, BigInt(value));
}

function packBigInt(out: Writer, value: bigint): void {
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return packNumber(out, Number(value));
  if (value < I64_MIN || value > U64_MAX) throw new Error("msgpack: integer does not fit in 64 bits");
  out.tag64(value < 0n ? 0xd3 : 0xcf, value);
}

function packString(out: Writer, value: string): void {
  const n = utf8Length(value);
  if (n <= 31) out.u8(0xa0 + n);
  else if (n <= 0xff) out.tagUint(0xd9, 1, n);
  else if (n <= 0xffff) out.tag16(0xda, n);
  else out.tag32(0xdb, n);
  out.text(value);
}

function packBytes(out: Writer, data: Uint8Array): void {
  if (data.length <= 0xff) out.tagUint(0xc4, 1, data.length);
  else if (data.length <= 0xffff) out.tag16(0xc5, data.length);
  else out.tag32(0xc6, data.length);
  out.raw(data);
}

function packVec3(out: Writer, value: { x: number; y: number; z: number }): void {
  out.u8(0xc7);
  out.u8(12);
  out.u8(EXT_VEC3);
  out.float32le(value.x);
  out.float32le(value.y);
  out.float32le(value.z);
}

function isSkipped(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function packEntries(out: Writer, entries: [unknown, unknown][], depth: number): void {
  const live = entries.filter(([, v]) => !isSkipped(v));
  packHeader(out, live.length, 0x80, 0xde, 0xdf);
  for (const [k, v] of live) {
    packValue(out, k, depth + 1);
    packValue(out, v, depth + 1);
  }
}

function packList(out: Writer, items: ArrayLike<unknown>, depth: number): void {
  packHeader(out, items.length, 0x90, 0xdc, 0xdd);
  for (let i = 0; i < items.length; i++) packValue(out, items[i], depth + 1);
}

function packObject(out: Writer, value: object, depth: number): void {
  if (Array.isArray(value)) return packList(out, value, depth);
  if (value instanceof ArrayBuffer) return packBytes(out, new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return packBytes(out, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof Map) return packEntries(out, [...value.entries()], depth);
  if (value instanceof Set) return packList(out, [...value], depth);
  if (isPlain(value) && isVec3(value)) return packVec3(out, value);
  const toJson: unknown = Reflect.get(value, "toJSON");
  if (typeof toJson === "function" && !isPlain(value)) return packValue(out, Reflect.apply(toJson, value, []), depth + 1);
  packEntries(out, Object.entries(value), depth);
}

function packValue(out: Writer, value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error("msgpack: cannot pack, depth limit exceeded (cyclic value?)");
  switch (typeof value) {
    case "undefined":
      return out.u8(0xc0);
    case "boolean":
      return out.u8(value ? 0xc3 : 0xc2);
    case "number":
      return packNumber(out, value);
    case "bigint":
      return packBigInt(out, value);
    case "string":
      return packString(out, value);
    case "object":
      if (value === null) return out.u8(0xc0);
      return packObject(out, value, depth);
    default:
      throw new Error(`msgpack: cannot pack a ${typeof value}`);
  }
}

/** Same bytes as the Lua codec for the values both languages share: a JS number without a fraction packs as an integer. */
export function msgpackPack(value: unknown): Uint8Array {
  const out = new Writer();
  packValue(out, value, 1);
  return out.result();
}

function utf8Decode(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  let i = start;
  while (i < end) {
    const b = bytes[i++] ?? 0;
    let c = b;
    if (b >= 0xf0 && i + 2 < end) {
      c = ((b & 0x07) << 18) | (((bytes[i++] ?? 0) & 0x3f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else if (b >= 0xe0) {
      c = ((b & 0x0f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else if (b >= 0xc0) {
      c = ((b & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    }
    if (c >= 0x10000) {
      c -= 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else out += String.fromCharCode(c);
  }
  return out;
}

class Reader {
  readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(n: number): number {
    if (this.pos + n > this.bytes.length) throw new Error("msgpack: unexpected end of data");
    const at = this.pos;
    this.pos += n;
    return at;
  }
}

function toBytes(data: MsgpackInput): Uint8Array {
  if (typeof data === "string") return Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("bad argument #1 to 'msgpack_unpack' (bytes expected)");
}

function unpackInt64(rd: Reader, unsigned: boolean): number | bigint {
  const at = rd.need(8);
  const big = unsigned ? rd.view.getBigUint64(at) : rd.view.getBigInt64(at);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

function unpackExt(rd: Reader, size: number): unknown {
  const at = rd.need(size + 1);
  const ext = rd.view.getInt8(at);
  const keys = EXT_KEYS[ext];
  if (keys === undefined || size !== keys.length * 4) return rd.bytes.slice(at + 1, at + 1 + size);
  const out: Record<string, number> = {};
  keys.forEach((key, i) => {
    out[key] = rd.view.getFloat32(at + 1 + i * 4, true);
  });
  return out;
}

function unpackArray(rd: Reader, count: number, depth: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push(unpackValue(rd, depth + 1));
  return out;
}

function unpackMap(rd: Reader, count: number, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const key = unpackValue(rd, depth + 1);
    const value = unpackValue(rd, depth + 1);
    if (key === null) continue;
    if (key === "__proto__") Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    else out[String(key)] = value;
  }
  return out;
}

function unpackLength(rd: Reader, tag: number): number {
  switch (tag) {
    case 0xc4:
    case 0xc7:
    case 0xd9:
      return rd.view.getUint8(rd.need(1));
    case 0xc5:
    case 0xc8:
    case 0xda:
    case 0xdc:
    case 0xde:
      return rd.view.getUint16(rd.need(2));
    default:
      return rd.view.getUint32(rd.need(4));
  }
}

function unpackSized(rd: Reader, tag: number, depth: number): unknown {
  const size = unpackLength(rd, tag);
  if (tag === 0xdc || tag === 0xdd) return unpackArray(rd, size, depth);
  if (tag === 0xde || tag === 0xdf) return unpackMap(rd, size, depth);
  if (tag >= 0xc7 && tag <= 0xc9) return unpackExt(rd, size);
  const at = rd.need(size);
  if (tag >= 0xc4 && tag <= 0xc6) return rd.bytes.slice(at, at + size);
  return utf8Decode(rd.bytes, at, at + size);
}

function unpackScalar(rd: Reader, tag: number): unknown {
  switch (tag) {
    case 0xca:
      return rd.view.getFloat32(rd.need(4));
    case 0xcb:
      return rd.view.getFloat64(rd.need(8));
    case 0xcc:
      return rd.view.getUint8(rd.need(1));
    case 0xcd:
      return rd.view.getUint16(rd.need(2));
    case 0xce:
      return rd.view.getUint32(rd.need(4));
    case 0xcf:
      return unpackInt64(rd, true);
    case 0xd0:
      return rd.view.getInt8(rd.need(1));
    case 0xd1:
      return rd.view.getInt16(rd.need(2));
    case 0xd2:
      return rd.view.getInt32(rd.need(4));
    case 0xd3:
      return unpackInt64(rd, false);
    case 0xd4:
    case 0xd5:
    case 0xd6:
    case 0xd7:
    case 0xd8:
      return unpackExt(rd, 1 << (tag - 0xd4));
    default:
      throw new Error(`msgpack: unsupported type 0x${tag.toString(16).padStart(2, "0")}`);
  }
}

function unpackValue(rd: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("msgpack: depth limit exceeded");
  const tag = rd.view.getUint8(rd.need(1));
  if (tag <= 0x7f) return tag;
  if (tag >= 0xe0) return tag - 0x100;
  if (tag <= 0x8f) return unpackMap(rd, tag & 0x0f, depth);
  if (tag <= 0x9f) return unpackArray(rd, tag & 0x0f, depth);
  if (tag <= 0xbf) {
    const size = tag & 0x1f;
    const at = rd.need(size);
    return utf8Decode(rd.bytes, at, at + size);
  }
  if (tag === 0xc0) return null;
  if (tag === 0xc2) return false;
  if (tag === 0xc3) return true;
  if ((tag >= 0xc4 && tag <= 0xc9) || tag === 0xd9 || tag === 0xda || tag === 0xdb || (tag >= 0xdc && tag <= 0xdf)) {
    return unpackSized(rd, tag, depth);
  }
  return unpackScalar(rd, tag);
}

export function msgpackUnpack(data: MsgpackInput): unknown {
  return unpackValue(new Reader(toBytes(data)), 1);
}

/** The payload of the `Trigger*Internal` functions: an array of the event arguments. */
function unpackArgs(payload: MsgpackInput): unknown[] {
  const args = msgpackUnpack(payload);
  if (!Array.isArray(args)) throw new Error("msgpack: unpack_args expects an array");
  return args;
}

export function installMsgpack(): void {
  expose("msgpack_pack", msgpackPack);
  expose("msgpack_unpack", msgpackUnpack);
  expose("TriggerEventInternal", (name: string, payload: MsgpackInput) => TriggerEvent(name, ...unpackArgs(payload)));
  if (side === "server") {
    const send = (name: string, target: unknown, payload: MsgpackInput): void => TriggerClientEvent(name, target, ...unpackArgs(payload));
    expose("TriggerClientEventInternal", send);
    expose("TriggerLatentClientEventInternal", send);
  } else {
    const send = (name: string, payload: MsgpackInput): void => TriggerServerEvent(name, ...unpackArgs(payload));
    expose("TriggerServerEventInternal", send);
    expose("TriggerLatentServerEventInternal", send);
  }
}
