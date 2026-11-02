import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AgentScope } from '../auth/policies.js';
import type { AgentPrincipal } from '../auth/principal.js';
import { ApiError } from '../common/errors.js';
import { ConfigReportDto, ProvisioningDto } from './provisioning.dto.js';
import { ProvisioningService } from './provisioning.service.js';

type AgentRequest = AuthenticatedRequest & { managementRequestId: string };
function ownPrincipal(
  req: AgentRequest,
  query: Record<string, unknown>,
): AgentPrincipal {
  if (Object.keys(query).length) throw new ApiError('invalid_request');
  const principal = req.principal;
  if (!principal || principal.kind !== 'agent') throw new ApiError('forbidden');
  // Optional headers are cross-checks only. Never turn them into selectors and
  // never let Express's merged header map hide duplicates.
  for (const [name, expected] of [
    ['x-server-id', principal.server_id],
    ['x-agent-id', principal.agent_id],
  ]) {
    const values: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i].toLowerCase() === name)
        values.push(req.rawHeaders[i + 1]);
    if (
      values.length > 1 ||
      (values.length === 1 &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          values[0],
        ))
    )
      throw new ApiError('invalid_request');
    if (values.length && values[0].toLowerCase() !== expected)
      throw new ApiError('forbidden');
  }
  return principal;
}
@ApiTags('Own Agent provisioning')
@ApiBearerAuth('AgentApiKey')
@ApiResponse({
  status: 400,
  description: 'Unknown query/body field or malformed/duplicate identity claim',
})
@ApiResponse({
  status: 401,
  description: 'Invalid, revoked, expired, inactive Agent or archived Server',
})
@ApiResponse({
  status: 403,
  description:
    'Missing required Agent scope or mismatched optional identity claim',
})
@ApiResponse({
  status: 409,
  description:
    'provisioning_not_ready or profile_not_provisioned; no implicit assignment/key creation',
})
@ApiResponse({
  status: 503,
  description:
    'Primary DB/transaction/audit unavailable; no partial receipt/report',
})
@Controller('api/v1/agent')
export class ProvisioningController {
  constructor(
    @Inject(ProvisioningService)
    private readonly provisioning: ProvisioningService,
  ) {}
  @Get('provisioning')
  @AgentScope('provisioning:read')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: ProvisioningDto })
  @ApiOperation({
    summary: 'Get own exact desired config and record provisioning receipt',
    description:
      'Requires provisioning:read via primary-DB Agent proof. IDs/OS from trusted proof/state only; no query resource selector. Cache-Control: no-store. Successful GET atomically records only delivery of immutable config, never applied or Online. Retired existing pins remain usable. Trusted configured ingest origin, never Host/forwarded headers. Default127.0.0.1:8000 is host-sender lab only, not VM qualification. Installer handoff only: no renderer, installation or real Grafana/TLS proof.',
  })
  get(
    @Req() req: AgentRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<ProvisioningDto> {
    return this.provisioning.get(ownPrincipal(req, query));
  }
  @Post('config-reports')
  @AgentScope('config:report')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiNoContentResponse({
    description:
      'Agent-reported result/time committed. Historical receipt may show drift; failed retains previous applied. Desired assignment and metric status untouched.',
  })
  @ApiOperation({
    summary: 'Record own Agent-reported config result',
    description:
      'Requires config:report. Agent-reported only, not proof of a running binary/config or Online. Exact published OS-compatible version/checksum must have an own provisioning receipt; historical valid receipts accepted without changing desired assignment. No raw config, stdout or secret. No-store.',
  })
  report(
    @Req() req: AgentRequest,
    @Query() query: Record<string, unknown>,
    @Body() input: ConfigReportDto,
  ): Promise<void> {
    return this.provisioning.report(
      ownPrincipal(req, query),
      input,
      req.managementRequestId,
    );
  }
}
