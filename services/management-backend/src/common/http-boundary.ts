import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { visit } from 'jsonc-parser';
import { Catch, HttpException, ValidationPipe } from '@nestjs/common';
import type {
  ArgumentsHost,
  ExceptionFilter,
  INestApplication,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import type { ManagementConfig } from '../config/config.js';
import { ApiError } from './errors.js';
import type { ApiCode } from './errors.js';
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const forbiddenProperties = new Set(['__proto__', 'constructor', 'prototype']);
type BoundaryRequest = Request & {
  rawBody?: Buffer;
  managementRequestId?: string;
};

export function parseStrictJson(raw: Buffer): unknown {
  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    const objects: Set<string>[] = [];
    let invalid = false;
    visit(
      text,
      {
        onObjectBegin: () => {
          objects.push(new Set());
        },
        onObjectProperty: (name) => {
          const names = objects[objects.length - 1];
          if (!names || names.has(name) || forbiddenProperties.has(name))
            invalid = true;
          names?.add(name);
        },
        onObjectEnd: () => {
          objects.pop();
        },
        onError: () => {
          invalid = true;
        },
      },
      {
        disallowComments: true,
        allowTrailingComma: false,
        allowEmptyContent: false,
      },
    );
    if (invalid) throw new Error();
    return JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error();
      return value;
    }) as unknown;
  } catch {
    throw new ApiError('invalid_request');
  }
}

function requestId(req: BoundaryRequest): string {
  if (!req.managementRequestId) {
    const supplied = req.headers['x-request-id'];
    req.managementRequestId =
      typeof supplied === 'string' && uuid.test(supplied)
        ? supplied
        : randomUUID();
  }
  return req.managementRequestId;
}
function sendError(req: BoundaryRequest, res: Response, error: ApiError): void {
  if (res.headersSent || res.destroyed) return;
  res.setHeader('X-Request-Id', requestId(req));
  res.setHeader('Cache-Control', 'no-store');
  res.status(error.status).json({
    code: error.code,
    message: error.message,
    request_id: requestId(req),
  });
}
function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof HttpException) {
    const codes: Record<number, ApiCode> = {
      400: 'invalid_request',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not_found',
      409: 'conflict',
      413: 'payload_too_large',
      429: 'rate_limited',
      503: 'dependency_unavailable',
    };
    return new ApiError(codes[error.getStatus()] ?? 'internal_error');
  }
  return new ApiError('internal_error');
}
@Catch()
class SanitizedExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    sendError(
      http.getRequest<BoundaryRequest>(),
      http.getResponse<Response>(),
      normalizeError(error),
    );
  }
}

export function installHttpBoundary(
  app: INestApplication,
  config: ManagementConfig,
  clock: Clock = systemClock,
): void {
  const server = app.getHttpServer() as Server & { maxHeaderSize: number };
  server.maxHeaderSize = 16 * 1024;
  server.maxHeadersCount = 64;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(10000);
  const express = app.getHttpAdapter().getInstance() as {
    disable(name: string): void;
    set(name: string, value: string | boolean): void;
  };
  express.disable('x-powered-by');
  express.set('query parser', 'simple');
  express.set('trust proxy', false);
  let active = 0;
  let tokens = config.MANAGEMENT_REQUEST_BURST;
  let refillAt = clock.monotonicMs();

  // Admission is deliberately installed before body reading and DTO evaluation.
  app.use((req: BoundaryRequest, res: Response, next: NextFunction) => {
    const id = requestId(req);
    res.setHeader('X-Request-Id', id);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.rawHeaders.length > 128) {
      res.setHeader('Connection', 'close');
      sendError(req, res, new ApiError('invalid_request'));
      return;
    }
    const health =
      req.method === 'GET' &&
      (req.url === '/health/live' || req.url === '/health/ready');
    if (!health) {
      const now = clock.monotonicMs();
      tokens = Math.min(
        config.MANAGEMENT_REQUEST_BURST,
        tokens +
          (Math.max(0, now - refillAt) *
            config.MANAGEMENT_REQUEST_RATE_PER_SECOND) /
            1000,
      );
      refillAt = now;
      if (active >= 16 || tokens < 1) {
        res.setHeader('Connection', 'close');
        sendError(req, res, new ApiError('rate_limited'));
        return;
      }
      tokens -= 1;
      active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active -= 1;
        res.off('finish', release);
        res.off('close', release);
      };
      res.once('finish', release);
      res.once('close', release);
    }
    next();
  });
  app.use((req: BoundaryRequest, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    // Use the same path view as Express for cap selection only (query excluded,
    // case-insensitive/optional trailing slash). NEVER rewrite signed originalUrl.
    const verifyPath = /^\/internal\/v1\/credentials\/verify\/?$/i.test(req.path);
    const profileWrite =
      ['POST', 'PATCH', 'PUT'].includes(req.method) &&
      /^\/api\/v1\/(?:monitoring-profiles(?:\/[^/]+(?:\/(?:versions|retire))?)?|profile-versions\/[^/]+(?:\/publish)?)\/?$/i.test(
        req.path,
      );
    const statusWrite =
      req.method === 'POST' &&
      /^\/internal\/v1\/status\/(?:epoch|reports)\/?$/i.test(req.path);
    const cap =
      req.method === 'POST' && verifyPath
        ? 8 * 1024
        : profileWrite || statusWrite
          ? 64 * 1024
          : 128 * 1024;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onAborted);
      res.off('close', onClose);
    };
    const fail = (code: ApiCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      res.setHeader('Connection', 'close');
      sendError(req, res, new ApiError(code));
      req.resume();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        fail('payload_too_large');
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks, size);
      req.rawBody = raw;
      chunks.length = 0;
      if (size > 0) {
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            req.headers['content-type'] ?? '',
          )
        ) {
          sendError(req, res, new ApiError('invalid_request'));
          return;
        }
        try {
          req.body = parseStrictJson(raw);
        } catch {
          sendError(req, res, new ApiError('invalid_request'));
          return;
        }
      }
      next();
    };
    const onAborted = () => {
      if (!settled) {
        settled = true;
        cleanup();
        chunks.length = 0;
        res.destroy();
      }
    };
    const onClose = () => {
      if (!settled) {
        settled = true;
        cleanup();
        chunks.length = 0;
      }
    };
    const timer = setTimeout(() => fail('invalid_request'), 5000);
    timer.unref();
    res.once('close', onClose);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onAborted);
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > cap))
      fail(Number(length) > cap ? 'payload_too_large' : 'invalid_request');
  });
  app.useGlobalFilters(new SanitizedExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
      exceptionFactory: () => new ApiError('invalid_request'),
    }),
  );
}
