import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';
import type { AgentAvailability } from '../../../../config/app.config.js';
import { emptyAgent, type AgentMetadata } from '../../../../integrations/aws/aws.port.js';
import { UUID_PATTERN, isUuid } from '../../../common/pagination.js';

export const PLATFORMS = ['linux', 'windows'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ONBOARDING_STATES = [
  'Pending',
  'Registered',
  'Configuring',
  'Verifying',
  'Success',
  'Failed',
  'Expired',
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

export const ONBOARDING_STAGES = [
  'AwaitingBootstrap',
  'CreatingActivation',
  'ReconcilingActivation',
  'AwaitingRegistration',
  'ApplyingConfig',
  'VerifyingMetrics',
  'Complete',
  'Failed',
  'Expired',
  'Decommissioning',
  'CleanupRequired',
  'Retired',
] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const MONITORING_HEALTH = ['Fresh', 'Stale', 'Offline', 'Unknown'] as const;
export type MonitoringHealth = (typeof MONITORING_HEALTH)[number];

export const BINDING_STATES = [
  'Active',
  'Decommissioning',
  'CleanupRequired',
  'Retired',
] as const;
export type BindingState = (typeof BINDING_STATES)[number];

export const ALERT_SYNC_STATES = ['Pending', 'Synced', 'Error'] as const;
export type AlertSyncState = (typeof ALERT_SYNC_STATES)[number];

export const ONBOARDING_ERROR_CODES = [
  'activation_ambiguous',
  'activation_expired',
  'activation_unavailable',
  'registration_conflict',
  'platform_mismatch',
  'configuration_failed',
  'configuration_timeout',
  'verification_timeout',
  'metrics_unavailable',
  'permission_denied',
  'contract_unqualified',
  'cleanup_required',
  'dependency_unavailable',
  'superseded',
] as const;
export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];

export class BootstrapIntentDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  @Matches(UUID_PATTERN)
  requestId!: string;
}

export class RetryIntentDto extends BootstrapIntentDto {
  @ApiProperty({ enum: ['retry-config', 'regenerate-unused'] })
  @IsIn(['retry-config', 'regenerate-unused'])
  mode!: 'retry-config' | 'regenerate-unused';
}

export type BootstrapIntent = BootstrapIntentDto;
export type RetryIntent = RetryIntentDto;

export interface MonitoringProjection {
  health: MonitoringHealth;
  lastObservedSampleAt: string | null;
  lastSuccessfulQueryAt: string | null;
}

export interface AlertSyncProjection {
  state: AlertSyncState;
  generation: number;
  desiredHash: string | null;
  syncedAt: string | null;
}

export interface OnboardingProgressDto {
  serverId: string;
  attemptId: string | null;
  enrollmentId: string | null;
  generation: number;
  state: OnboardingState;
  stage: OnboardingStage;
  bindingState: BindingState | null;
  expiresAt: string | null;
  nextRunAt: string | null;
  errorCode: OnboardingErrorCode | null;
  monitoring: MonitoringProjection;
  alertSync: AlertSyncProjection;
  availability: AgentAvailability;
  agent: AgentMetadata;
}

export type OnboardingProgress = OnboardingProgressDto;

export type BootstrapAttachment =
  | {
      bytes: Buffer;
      contentType: 'text/x-shellscript';
      filename: `infrapulse-${string}.sh`;
    }
  | {
      bytes: Buffer;
      contentType: 'text/plain';
      filename: `infrapulse-${string}.ps1`;
    };

export interface BootstrapLinkDto {
  serverId: string;
  attemptId: string;
  generation: number;
  platform: Platform;
  url: string;
  expiresAt: string;
  command: string;
}

export type BootstrapLink = BootstrapLinkDto;

export function pendingOnboardingProgress(serverId: string): OnboardingProgressDto {
  if (!isUuid(serverId)) throw new Error('Invalid onboarding progress.');
  return {
    serverId,
    availability: { available: false, configurationVersion: null, reason: 'release_missing' },
    agent: emptyAgent(),
    attemptId: null,
    enrollmentId: null,
    generation: 0,
    state: 'Pending',
    stage: 'AwaitingBootstrap',
    bindingState: null,
    expiresAt: null,
    nextRunAt: null,
    errorCode: null,
    monitoring: {
      health: 'Unknown',
      lastObservedSampleAt: null,
      lastSuccessfulQueryAt: null,
    },
    alertSync: {
      state: 'Pending',
      generation: 0,
      desiredHash: null,
      syncedAt: null,
    },
  };
}
