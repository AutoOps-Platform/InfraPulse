import { createHash, createHmac } from 'node:crypto';

export interface AwsStaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type AwsCredentialsResolver = () => Promise<AwsStaticCredentials>;

export interface AmpRangePoint {
  timestampMs: number;
  value: number;
}

const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signSigV4(input: {
  method: 'POST';
  url: URL;
  region: string;
  service: string;
  body: string;
  contentType: string;
  credentials: AwsStaticCredentials;
  now?: Date;
}): Record<string, string> {
  const { amzDate, dateStamp } = formatAmzDate(input.now ?? new Date());
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    'content-type': input.contentType,
    host: input.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.credentials.sessionToken) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    input.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function queryAmpRange(input: {
  endpoint: string;
  region: string;
  credentials: AwsCredentialsResolver;
  promql: string;
  startSec: number;
  endSec: number;
  stepSec: number;
  signal: AbortSignal;
}): Promise<AmpRangePoint[]> {
  const url = new URL('api/v1/query_range', input.endpoint);
  const params = new URLSearchParams({
    query: input.promql,
    start: String(input.startSec),
    end: String(input.endSec),
    step: String(input.stepSec),
  });
  const body = params.toString();
  const creds = await input.credentials();
  const headers = signSigV4({
    method: 'POST',
    url,
    region: input.region,
    service: 'aps',
    body,
    contentType: 'application/x-www-form-urlencoded',
    credentials: creds,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: input.signal,
  });
  if (response.status === 401 || response.status === 403) {
    const err = new Error('AccessDeniedException');
    err.name = 'AccessDeniedException';
    throw err;
  }
  if (!response.ok) {
    throw new Error(`AMP_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as {
    status?: string;
    data?: {
      resultType?: string;
      result?: Array<{ values?: Array<[number, string]> }>;
    };
  };
  if (payload.status !== 'success' || payload.data?.resultType !== 'matrix' || !Array.isArray(payload.data.result)) {
    throw new Error('AMP_INVALID_RESPONSE');
  }
  const byTimestamp = new Map<number, number>();
  for (const series of payload.data.result) {
    for (const entry of series.values ?? []) {
      const epochSec = Number(entry[0]);
      const val = Number(entry[1]);
      if (Number.isFinite(epochSec) && Number.isFinite(val)) {
        byTimestamp.set(Math.round(epochSec * 1000), val);
      }
    }
  }
  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestampMs, value]) => ({ timestampMs, value }));
}
