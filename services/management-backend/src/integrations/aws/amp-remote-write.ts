import { signSigV4, type AwsCredentialsResolver } from './amp-query.js';

export interface AmpWriteSample {
  name: string;
  labels?: Record<string, string>;
  value: number;
  timestampMs: number;
}

export type AmpRemoteWriteFn = (
  samples: readonly AmpWriteSample[],
  signal: AbortSignal,
) => Promise<void>;

function encodeVarint(value: number | bigint): Buffer {
  let n = typeof value === 'bigint' ? value : BigInt(value);
  if (n < 0n) {
    n = BigInt.asUintN(64, n);
  }
  const bytes: number[] = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

function encodeLabel(name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const valBuf = Buffer.from(value, 'utf8');
  return Buffer.concat([
    encodeLengthDelimited(1, nameBuf),
    encodeLengthDelimited(2, valBuf),
  ]);
}

function encodeSample(value: number, timestampMs: number): Buffer {
  const valueBuf = Buffer.alloc(9);
  valueBuf[0] = (1 << 3) | 1; // field 1, wire type 1 (64-bit double)
  valueBuf.writeDoubleLE(value, 1);
  const tsTag = Buffer.from([(2 << 3) | 0]); // field 2, wire type 0 (int64 varint)
  const tsVal = encodeVarint(Math.trunc(timestampMs));
  return Buffer.concat([valueBuf, tsTag, tsVal]);
}

/**
 * Encodes Prometheus Remote Write 1.0 WriteRequest protobuf:
 * message WriteRequest { repeated TimeSeries timeseries = 1; }
 * message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
 */
export function encodeWriteRequestProtobuf(samples: readonly AmpWriteSample[]): Buffer {
  const chunks: Buffer[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.value) || !Number.isFinite(sample.timestampMs)) continue;
    const allLabels: Record<string, string> = {
      ...sample.labels,
      __name__: sample.name,
    };
    const sortedNames = Object.keys(allLabels).sort();
    const tsParts: Buffer[] = [];
    for (const labelName of sortedNames) {
      const labelValue = allLabels[labelName];
      if (labelValue === '') continue;
      tsParts.push(encodeLengthDelimited(1, encodeLabel(labelName, labelValue)));
    }
    tsParts.push(encodeLengthDelimited(2, encodeSample(sample.value, sample.timestampMs)));
    chunks.push(encodeLengthDelimited(1, Buffer.concat(tsParts)));
  }
  return Buffer.concat(chunks);
}

/**
 * Encodes raw bytes as a spec-compliant Snappy block (uncompressed literal stream).
 * Accepted natively by Go's github.com/golang/snappy decoder used by AMP.
 */
export function encodeSnappyBlock(raw: Buffer): Buffer {
  const parts: Buffer[] = [encodeVarint(raw.length)];
  const MAX_LITERAL = 65536;
  for (let offset = 0; offset < raw.length; offset += MAX_LITERAL) {
    const chunkLen = Math.min(MAX_LITERAL, raw.length - offset);
    const n = chunkLen - 1;
    if (n < 60) {
      parts.push(Buffer.from([n << 2]));
    } else if (n <= 0xff) {
      parts.push(Buffer.from([60 << 2, n & 0xff]));
    } else {
      parts.push(Buffer.from([61 << 2, n & 0xff, (n >> 8) & 0xff]));
    }
    parts.push(raw.subarray(offset, offset + chunkLen));
  }
  return Buffer.concat(parts);
}

export async function remoteWriteToAmp(input: {
  endpoint: string;
  region: string;
  credentials: AwsCredentialsResolver;
  samples: readonly AmpWriteSample[];
  signal: AbortSignal;
}): Promise<void> {
  if (!input.samples.length) return;
  const url = new URL('api/v1/remote_write', input.endpoint);
  const proto = encodeWriteRequestProtobuf(input.samples);
  if (!proto.length) return;
  const body = encodeSnappyBlock(proto);
  const creds = await input.credentials();
  const headers = signSigV4({
    method: 'POST',
    url,
    region: input.region,
    service: 'aps',
    body,
    contentType: 'application/x-protobuf',
    extraHeaders: {
      'content-encoding': 'snappy',
      'x-prometheus-remote-write-version': '0.1.0',
    },
    credentials: creds,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
    signal: input.signal,
  });
  if (response.status === 401 || response.status === 403) {
    const err = new Error('AccessDeniedException');
    err.name = 'AccessDeniedException';
    throw err;
  }
  if (!response.ok) {
    throw new Error(`AMP_REMOTE_WRITE_HTTP_${response.status}`);
  }
}
