import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.js';
import { ServiceScope, UserRoles } from '../auth/policies.js';
import type { UserPrincipal } from '../auth/principal.js';
import { transitionBody } from '../agents/agents.dto.js';
import { ApiError } from '../common/errors.js';
import { inventoryPageSchema } from '../common/openapi.js';
import type { PageQuery } from '../common/pagination.js';
import {
  CredentialDto,
  IssueDto,
  IssuedCredentialDto,
  IssuanceConflict,
  RotateDto,
  VerifyDto,
} from './credentials.dto.js';
import { CredentialsService } from './credentials.service.js';

type AuditRequest = { managementRequestId: string };
@ApiTags('Credentials')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Admin required, including metadata' })
@ApiResponse({
  status: 503,
  description: 'Dependency/audit unavailable; no secret or exception detail',
})
@Controller()
export class CredentialsController {
  constructor(
    @Inject(CredentialsService)
    private readonly credentials: CredentialsService,
  ) {}
  @Get('api/v1/credentials')
  @UserRoles('Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('CredentialDto') })
  @ApiOperation({
    summary: 'List safe credential metadata',
    description:
      'Admin only; limit20/max100, cursor and agent/server filters. Never plaintext or verifier. No-store.',
  })
  list(@Query() query: PageQuery) {
    return this.credentials.list(query);
  }
  @Get('api/v1/credentials/:id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: CredentialDto })
  @ApiOperation({
    summary: 'Get safe credential metadata',
    description:
      'Admin only, including rotation history links; no secret retrieval. No-store.',
  })
  get(@Param('id') id: string) {
    return this.credentials.get(id);
  }
  @Post('api/v1/agents/:id/credentials')
  @UserRoles('Admin')
  @ApiCreatedResponse({
    type: IssuedCredentialDto,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  @ApiBody({ type: IssueDto })
  @ApiResponse({
    status: 409,
    description:
      'Lifecycle conflict, or secret_already_issued with safe credential metadata. NEVER replay a secret.',
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        request_id: { type: 'string', format: 'uuid' },
        credential: { $ref: getSchemaPath(CredentialDto) },
      },
    },
  })
  @ApiOperation({
    summary: 'Issue one-time Agent credential',
    description:
      'Admin only. Active Agent/unarchived Server. Default30/max365 days, allowed nonempty scope subset. If response is lost: inspect metadata, revoke and issue with a NEW operation UUID. Never blindly retry to recover a secret.',
  })
  issue(
    @Param('id') id: string,
    @Body() input: IssueDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.oneTime(
      () => this.credentials.issue(id, input, actor, req.managementRequestId),
      req,
      res,
    );
  }
  @Post('api/v1/credentials/:id/rotate')
  @UserRoles('Admin')
  @ApiCreatedResponse({
    type: IssuedCredentialDto,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  @ApiBody({ type: RotateDto })
  @ApiResponse({
    status: 409,
    description:
      'Expired/revoked/already-successor/lifecycle conflict, or operation UUID already committed with safe metadata, NEVER the secret.',
  })
  @ApiOperation({
    summary: 'Rotate once, same Agent',
    description:
      'Admin only. Unique successor; old cutoff min(existing cutoff, DB now+300s) without extending expiry. One-time new secret, no-store. Recovery: metadata/revoke/new operation UUID.',
  })
  rotate(
    @Param('id') id: string,
    @Body() input: RotateDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.oneTime(
      () => this.credentials.rotate(id, input, actor, req.managementRequestId),
      req,
      res,
    );
  }
  @Post('api/v1/credentials/:id/revoke')
  @UserRoles('Admin')
  @HttpCode(204)
  @ApiNoContentResponse()
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false },
  })
  @ApiOperation({
    summary: 'Revoke irreversibly',
    description:
      'Admin only. Idempotent; lifecycle locks and atomic audit. Does not disable other Agent keys. Enable never revives this credential. No-store.',
  })
  revoke(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    transitionBody(input);
    return this.credentials.revoke(id, actor, req.managementRequestId);
  }
  private async oneTime(
    work: () => Promise<IssuedCredentialDto>,
    req: AuditRequest,
    res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof IssuanceConflict)) throw error;
      res.status(409);
      return {
        code: error.code,
        message: error.message,
        request_id: req.managementRequestId,
        credential: error.credential,
      };
    }
  }
}

@ApiTags('Internal credentials')
@ApiBearerAuth('InternalServiceAssertion')
@ApiResponse({
  status: 401,
  description: 'Invalid signed service assertion/replay',
})
@ApiResponse({
  status: 403,
  description: 'Missing trusted credentials:verify scope',
})
@ApiResponse({
  status: 503,
  description: 'Primary DB/pool/deadline unavailable (never inactive fallback)',
})
@Controller('internal/v1/credentials')
export class InternalCredentialsController {
  constructor(
    @Inject(CredentialsService)
    private readonly credentials: CredentialsService,
  ) {}
  @Post('verify')
  @HttpCode(200)
  @ServiceScope('credentials:verify')
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['api_key'],
      properties: {
        api_key: {
          type: 'string',
          writeOnly: true,
          maxLength: 8192,
          description: 'Exact key, whole JSON cap8KiB. Never URL/log.',
        },
      },
    },
  })
  @ApiResponse({ status: 413, description: 'Whole request exceeds8KiB' })
  @ApiOkResponse({
    schema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['active'],
          properties: { active: { type: 'boolean', enum: [false] } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'active',
            'credential_id',
            'server_id',
            'agent_id',
            'scopes',
            'expires_at',
            'cache_ttl_ms',
          ],
          properties: {
            active: { type: 'boolean', enum: [true] },
            credential_id: { type: 'string', format: 'uuid' },
            server_id: { type: 'string', format: 'uuid' },
            agent_id: { type: 'string', format: 'uuid' },
            scopes: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              uniqueItems: true,
              items: {
                type: 'string',
                enum: ['metrics:write', 'provisioning:read', 'config:report'],
              },
            },
            expires_at: { type: 'string', format: 'date-time' },
            cache_ttl_ms: { type: 'integer', minimum: 1, maximum: 30000 },
          },
        },
      ],
    },
  })
  @ApiOperation({
    summary: 'Verify Gateway metrics credential on primary DB',
    description:
      'Signed credentials:verify only; api_key is the sole JSON member, max8KiB. Requires metrics:write. Generic inactive proof; no existence reasons. No positive cache. TTL floor from DB snapshot, expires_at effective cutoff, no-store. Never put key in URL.',
  })
  verify(@Body() input: VerifyDto, @Query() query: PageQuery) {
    if (Object.keys(query).length) throw new ApiError('invalid_request');
    return this.credentials.verify(input.api_key, 'metrics:write');
  }
  @Get('health')
  @HttpCode(204)
  @ServiceScope('credentials:verify')
  @ApiNoContentResponse()
  @ApiOperation({
    summary: 'Signed credentials service health',
    description:
      'Same trusted credentials:verify service policy, fresh bound nonce. No real Agent key needed. Not public health; no-store.',
  })
  health(): void {}
}
