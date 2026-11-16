import type { RsiTaskScope, RsiTrainingCase } from './types.js';

export type RsiReplayJson =
  | null
  | boolean
  | number
  | string
  | RsiReplayJson[]
  | { [key: string]: RsiReplayJson };
export type RsiReplaySplit = 'training' | 'validation' | 'holdout' | 'regression';
export interface RsiReplayProfile {
  id: string;
  projectId: string;
  file: string;
  enabled: boolean;
  contentConsent: boolean;
  version: 1;
  updatedAt: number;
}
export interface RsiReplayCaptureSummary {
  id: string;
  profileId: string;
  runId: string;
  projectId: string;
  taskScope: RsiTaskScope;
  createdAt: number;
  completedAt?: number;
  status: 'capturing' | 'completed' | 'revoked';
}
export interface RsiReplayCapture extends RsiReplayCaptureSummary {
  sourceAssetId: string;
  completedAssetId?: string;
  contractDigest: string;
  sourceGroupDigest: string;
  receiptDigest?: string;
}
export interface RsiReplayGrade {
  passed: boolean;
  checks: string[];
}
/** Trusted host callback, never deserialized from requests; must validate its rules. */
export type RsiReplayGrader = (content: string, rules: RsiReplayJson) => RsiReplayGrade;
export interface RsiReplayCaseSummary {
  id: string;
  captureId: string;
  profileId: string;
  projectId: string;
  runId: string;
  taskScope: RsiTaskScope;
  kind: 'problem' | 'regression';
  groupDigest: string;
  fixtureDigest: string;
  graderVersion: string;
  createdAt: number;
  initialPassed: boolean;
  referencePassed: boolean;
}
export interface RsiReplayCaseRecord extends RsiReplayCaseSummary {
  privateAssetId: string;
  initialGroupDigest: string;
}
export interface RsiReplayManifest {
  id: string;
  taskScope: RsiTaskScope;
  cases: Record<RsiReplaySplit, RsiTrainingCase[]>;
  createdAt: number;
}
export interface RsiReplayState {
  schemaVersion: 1;
  profiles: RsiReplayProfile[];
  captures: RsiReplayCapture[];
  cases: RsiReplayCaseRecord[];
  manifests: RsiReplayManifest[];
}
export interface RsiReplayCaptureInput {
  profileId: string;
  runId: string;
  taskScope: RsiTaskScope;
  request: string;
  initialContent: string;
  contractDigest: string;
  sourceGroupDigest: string;
}
export interface RsiReplayCaptureReview {
  request: string;
  initialContent: string;
  finalContent: string;
  contractDigest: string;
  receiptDigest: string;
}
