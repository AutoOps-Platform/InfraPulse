import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
  Catch,
  HttpException,
  ValidationPipe,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import {
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
  getSchemaPath,
} from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import type { ManagementConfig } from '../../config/app.config.js';
import { AuditDto } from '../modules/audit/dto/audit.dto.js';
import { GroupDto } from '../modules/groups/dto/groups.dto.js';
import { ServerDto } from '../modules/servers/dto/servers.dto.js';
import { SslTargetDto } from '../modules/ssl-targets/dto/ssl-targets.dto.js';
import { ApiError, systemClock, type ApiCode, type Clock } from './errors.js';
import { UUID_PATTERN, parseStrictJson } from './pagination.js';

export { parseStrictJson };

const MAX_JSON_BODY_BYTES = 128 * 1024;

type BoundaryRequest = Request & {
  rawBody?: Buffer;
  managementRequestId?: string;
};

export function inventoryPageSchema(model: string) {
  return {
    type: 'object' as const,
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array' as const, items: { $ref: getSchemaPath(model) } },
      next_cursor: {
        type: 'string' as const,
        nullable: true,
        description: 'Opaque validated continuation cursor; null at end.',
      },
    },
  };
}

export class ApiErrorDto {
  @ApiProperty({ description: 'Finite sanitized error code.' })
  code!: string;

  @ApiProperty({ description: 'Finite public message; no exception detail.' })
  message!: string;

  @ApiProperty({ format: 'uuid' })
  request_id!: string;
}

export class MeDto {
  @ApiProperty({ enum: ['user'] })
  kind!: 'user';

  @ApiProperty()
  issuer!: string;

  @ApiProperty({ description: 'Stable opaque subject, never inferred from a username.' })
  subject!: string;

  @ApiProperty()
  context!: string;

  @ApiProperty({ enum: ['Viewer', 'Operator', 'Admin'] })
  role!: string;

  @ApiProperty({ required: false, maxLength: 128 })
  display?: string;
}

function requestId(req: BoundaryRequest): string {
  if (!req.managementRequestId) {
    const supplied = req.headers['x-request-id'];
    req.managementRequestId =
      typeof supplied === 'string' && UUID_PATTERN.test(supplied) ? supplied : randomUUID();
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
  server.setTimeout(10_000);

  const express = app.getHttpAdapter().getInstance() as {
    disable: (name: string) => void;
    set: (name: string, value: string | boolean) => void;
  };
  express.disable('x-powered-by');
  express.set('query parser', 'simple');
  express.set('trust proxy', false);

  let active = 0;
  let tokens = config.MANAGEMENT_REQUEST_BURST;
  let refillAt = clock.monotonicMs();

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

    const isHealth =
      req.method === 'GET' && (req.url === '/health/live' || req.url === '/health/ready');
    if (!isHealth) {
      const now = clock.monotonicMs();
      tokens = Math.min(
        config.MANAGEMENT_REQUEST_BURST,
        tokens +
          (Math.max(0, now - refillAt) * config.MANAGEMENT_REQUEST_RATE_PER_SECOND) / 1000,
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
      if (size > MAX_JSON_BODY_BYTES) {
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
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
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
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BODY_BYTES)) {
      fail(Number(length) > MAX_JSON_BODY_BYTES ? 'payload_too_large' : 'invalid_request');
    }
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

export function managementOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('InfraPulse Management')
    .setVersion('1')
    .setDescription(
      'Default deny. Per-request signed method, exact raw target and body; nonce is single use. User Viewer/Operator read only; Admin mutations. AWS onboarding uses native SSM and CloudWatch credentials. Signed HTTP does not replace TLS.',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Ed25519 JWT',
        description: 'User assertion, maximum 60 seconds; org role and default context required.',
      },
      'AdminAssertion',
    )
    .build();

  return SwaggerModule.createDocument(app, config, {
    extraModels: [ApiErrorDto, MeDto, ServerDto, GroupDto, AuditDto, SslTargetDto],
  });
}

export function installOpenApi(
  app: INestApplication,
  options: { enabled: boolean; listenHost: string } = {
    enabled: false,
    listenHost: '127.0.0.1',
  },
): void {
  if (!options.enabled) return;
  if (!['127.0.0.1', '::1'].includes(options.listenHost)) {
    throw new Error('Loopback docs required.');
  }
  app.use(
    '/docs',
    (
      req: { socket: { remoteAddress?: string } },
      res: { status: (code: number) => { end: () => void } },
      next: () => void,
    ) => {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
        res.status(404).end();
        return;
      }
      next();
    },
  );
  SwaggerModule.setup('docs', app, managementOpenApi(app), {
    swaggerOptions: { persistAuthorization: false },
    raw: false,
  });
}
