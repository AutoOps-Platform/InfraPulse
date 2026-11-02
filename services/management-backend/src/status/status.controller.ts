import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { ServiceScope } from '../auth/policies.js';
import { ApiError } from '../common/errors.js';
import {
  EpochDto,
  EpochOpenDto,
  ReportAckDto,
  ReportChunkDto,
} from './status.dto.js';
import { StatusService } from './status.service.js';
function principal(req: AuthenticatedRequest, query: Record<string, unknown>) {
  if (Object.keys(query).length) throw new ApiError('invalid_request');
  if (req.principal?.kind !== 'service') throw new ApiError('forbidden');
  return req.principal;
}
@ApiTags('Trusted observation')
@ApiBearerAuth('InternalServiceAssertion')
@ApiResponse({
  status: 400,
  description:
    'Invalid bounded report, timestamp or identity relationship; unknown fields/selectors rejected.',
})
@ApiResponse({
  status: 409,
  description:
    'Epoch CAS, retired boot, sequence or manifest conflict. No heartbeat refresh on committed replay.',
})
@ApiResponse({
  status: 413,
  description:
    '64KiB raw status request or 256KiB bounded logical/staged payload exceeded.',
})
@ApiResponse({
  status: 503,
  description:
    'Primary database/transaction unavailable; no partial Agent/coverage commit.',
})
@Controller('internal/v1/status')
export class StatusController {
  constructor(@Inject(StatusService) private readonly status: StatusService) {}
  @Get('epoch')
  @ServiceScope('status:write')
  @ApiOkResponse({ type: EpochDto })
  @ApiOperation({
    summary: 'Read configured source epoch',
    description:
      'Trusted issuer+subject only; no public source selector. Epoch0 has no boot or activation.',
  })
  current(
    @Req() req: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
  ) {
    return this.status.currentEpoch(principal(req, query));
  }
  @Post('epoch')
  @HttpCode(200)
  @ServiceScope('status:write')
  @ApiOkResponse({ type: EpochDto })
  @ApiOperation({
    summary: 'CAS activate boot',
    description:
      'Server-assigned monotonic epoch. Rejects boot_started_at > DB now + 5s; truthful delayed unseen boot is allowed, but unseen new boot must start strictly later than current. Exact current boot retry preserves activation; retired boot never reactivates.',
  })
  open(
    @Req() req: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
    @Body() body: EpochOpenDto,
  ) {
    return this.status.openEpoch(principal(req, query), body);
  }
  @Post('reports')
  @HttpCode(200)
  @ServiceScope('status:write')
  @ApiOkResponse({ type: ReportAckDto })
  @ApiOperation({
    summary: 'Stage/finalize one bounded observation snapshot',
    description:
      'RFC8785 SHA256 logical envelope/record subset. 4chunks,256records/chunk,1024Agents,256KiB logical/staging,30s deadline. Out-of-order chunks; complete atomic Agent GREATEST+coverage commit. Empty heartbeat allowed. Normal pending preserves completed confidence; loss/expiry/tamper breaks coverage. Historical inactive evidence never grants permission. Positive evidence is not machine power state or Grafana qualification.',
  })
  report(
    @Req() req: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
    @Body() body: ReportChunkDto,
  ) {
    return this.status.acceptReport(principal(req, query), body);
  }
}
