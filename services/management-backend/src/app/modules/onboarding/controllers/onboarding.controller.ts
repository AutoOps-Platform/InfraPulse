import { Body, Controller, Get, Header, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiError } from '../../../common/errors.js';
import { ApiErrorDto } from '../../../common/http.js';
import {
  CurrentUser,
  UserRoles,
  type UserPrincipal,
} from '../../auth/guards/auth.guard.js';
import {
  ALERT_SYNC_STATES,
  BINDING_STATES,
  BootstrapIntentDto,
  MONITORING_HEALTH,
  ONBOARDING_ERROR_CODES,
  ONBOARDING_STAGES,
  ONBOARDING_STATES,
  RetryIntentDto,
} from '../dto/onboarding.dto.js';
import { assertBootstrapAttachment } from '../services/bootstrap.service.js';
import { OnboardingService } from '../services/onboarding.service.js';

const progressSchema = {
  type: 'object' as const,
  additionalProperties: false,
  required: [
    'serverId',
    'attemptId',
    'enrollmentId',
    'generation',
    'state',
    'stage',
    'bindingState',
    'expiresAt',
    'nextRunAt',
    'errorCode',
    'monitoring',
    'alertSync',
  ],
  properties: {
    serverId: { type: 'string' as const, format: 'uuid' },
    attemptId: { type: 'string' as const, format: 'uuid', nullable: true },
    enrollmentId: { type: 'string' as const, format: 'uuid', nullable: true },
    generation: { type: 'integer' as const, minimum: 0 },
    state: { type: 'string' as const, enum: [...ONBOARDING_STATES] },
    stage: { type: 'string' as const, enum: [...ONBOARDING_STAGES] },
    bindingState: { type: 'string' as const, enum: [...BINDING_STATES], nullable: true },
    expiresAt: { type: 'string' as const, format: 'date-time', nullable: true },
    nextRunAt: { type: 'string' as const, format: 'date-time', nullable: true },
    errorCode: { type: 'string' as const, enum: [...ONBOARDING_ERROR_CODES], nullable: true },
    monitoring: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['health', 'lastObservedSampleAt', 'lastSuccessfulQueryAt'],
      properties: {
        health: { type: 'string' as const, enum: [...MONITORING_HEALTH] },
        lastObservedSampleAt: { type: 'string' as const, format: 'date-time', nullable: true },
        lastSuccessfulQueryAt: { type: 'string' as const, format: 'date-time', nullable: true },
      },
    },
    alertSync: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['state', 'generation', 'desiredHash', 'syncedAt'],
      properties: {
        state: { type: 'string' as const, enum: [...ALERT_SYNC_STATES] },
        generation: { type: 'integer' as const, minimum: 0 },
        desiredHash: { type: 'string' as const, pattern: '^[a-f0-9]{64}$', nullable: true },
        syncedAt: { type: 'string' as const, format: 'date-time', nullable: true },
      },
    },
  },
};

@ApiTags('Onboarding')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 400, type: ApiErrorDto })
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@ApiResponse({
  status: 409,
  type: ApiErrorDto,
  description: 'Conflict, consumed secret or unqualified assets; never replay an attachment.',
})
@ApiResponse({ status: 503, type: ApiErrorDto })
@Controller('api/v1/servers')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get(':id/onboarding')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiResponse({ status: 200, schema: progressSchema })
  progress(@Param('id') id: string) {
    return this.onboarding.progress(id);
  }

  @Post(':id/onboarding/bootstrap')
  @HttpCode(200)
  @UserRoles('Admin')
  @ApiBody({ type: BootstrapIntentDto })
  @ApiOperation({
    summary: 'Download bootstrap once',
    description:
      'No automatic download replay. After loss, read safe progress and explicitly regenerate-unused when eligible.',
  })
  @ApiResponse({
    status: 200,
    content: {
      'text/x-shellscript': { schema: { type: 'string', format: 'binary' } },
      'text/plain': { schema: { type: 'string', format: 'binary' } },
    },
    headers: {
      'Content-Disposition': {
        schema: { type: 'string' },
        description: 'attachment; filename="infrapulse-<serverUUID>.sh" or .ps1',
      },
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      'X-Content-Type-Options': { schema: { type: 'string', enum: ['nosniff'] } },
    },
  })
  async bootstrap(
    @Param('id') id: string,
    @Body() intent: BootstrapIntentDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const attachment = await this.onboarding.bootstrap(id, intent, actor);
    try {
      const platform = attachment.contentType === 'text/x-shellscript' ? 'linux' : 'windows';
      assertBootstrapAttachment(id, platform, attachment);
      if (req.aborted || res.destroyed || res.headersSent) throw new ApiError('conflict');

      res.status(200);
      res.setHeader('Content-Type', attachment.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', attachment.bytes.length);

      const erase = () => attachment.bytes.fill(0);
      res.once('finish', erase);
      res.once('close', erase);
      res.end(attachment.bytes);
    } catch {
      attachment.bytes.fill(0);
      if (!res.headersSent) {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Disposition');
        res.removeHeader('Content-Type');
      }
      throw new ApiError('conflict');
    }
  }

  @Post(':id/onboarding/bootstrap-link')
  @HttpCode(200)
  @UserRoles('Admin')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiBody({ type: BootstrapIntentDto })
  @ApiOperation({
    summary: 'Issue one-time presigned bootstrap command',
    description:
      'Uploads the rendered bootstrap script to the private ephemeral S3 bucket and returns a 30-minute presigned URL and one-line install command. No automatic replay.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['serverId', 'attemptId', 'generation', 'platform', 'url', 'expiresAt', 'command'],
      properties: {
        serverId: { type: 'string', format: 'uuid' },
        attemptId: { type: 'string', format: 'uuid' },
        generation: { type: 'integer', minimum: 1 },
        platform: { type: 'string', enum: ['linux', 'windows'] },
        url: { type: 'string', format: 'uri' },
        expiresAt: { type: 'string', format: 'date-time' },
        command: { type: 'string' },
      },
    },
  })
  bootstrapLink(
    @Param('id') id: string,
    @Body() intent: BootstrapIntentDto,
    @CurrentUser() actor: UserPrincipal,
  ) {
    return this.onboarding.bootstrapLink(id, intent, actor);
  }

  @Post(':id/onboarding/retry')
  @HttpCode(202)
  @UserRoles('Admin')
  @ApiBody({ type: RetryIntentDto })
  @ApiResponse({ status: 202, schema: progressSchema })
  retry(
    @Param('id') id: string,
    @Body() intent: RetryIntentDto,
    @CurrentUser() actor: UserPrincipal,
  ) {
    return this.onboarding.retry(id, intent, actor);
  }

  @Post(':id/decommission')
  @HttpCode(202)
  @UserRoles('Admin')
  @ApiBody({ type: BootstrapIntentDto })
  @ApiOperation({
    summary: 'Request asynchronous B6 decommission',
    description:
      'Persists a fenced asynchronous cleanup intent. A fresh signed request explicitly retries CleanupRequired without replaying uncertain mutations; duplicate requests are harmless.',
  })
  @ApiResponse({ status: 202, schema: progressSchema })
  decommission(
    @Param('id') id: string,
    @Body() intent: BootstrapIntentDto,
    @CurrentUser() actor: UserPrincipal,
  ) {
    return this.onboarding.decommission(id, intent, actor);
  }
}
