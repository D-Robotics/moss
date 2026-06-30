import type { DeviceFamily } from './device-family.js';





/** Describes a camera interface on a device. @public */
export interface CameraInterface {
  
  type: 'usb' | 'mipi' | 'gmsl' | 'other';
  
  count: number;
  
  notes?: string;
}





/** GPIO and peripheral bus specifications for a device. @public */
export interface GpioSpec {
  
  pinCount: number;
  
  gpioCount: number;
  
  i2cBuses: number;
  
  spiBuses: number;
  
  uartPorts: number;
  
  pwmChannels: number;
  
  voltage: string;
  
  notes?: string;
}










/** Base profile for a device: platform, SoC, compute, RAM, model format, I/O, and limitations. @public */
export interface DeviceProfileBase {
  
  platform: string;
  
  displayName: string;
  
  soc: string;
  
  computeUnit: string;
  
  computeTops: number;
  
  cpu: string;
  
  ramGb: number;
  
  modelFormat: string;
  
  diagnosticCommand: string;
  
  runtimeBasePath: string;
  
  systemPython: string;
  
  inferLibPackage: string;
  
  detectionPatterns: string[];
  
  limitations: string[];
  
  docBaseUrl: string;
  
  capabilityNotes: string[];

  

  
  cameraInterfaces?: CameraInterface[];
  
  gpio?: GpioSpec;
  
  networkInterfaces?: string[];
  
  storageSpec?: string;
  
  powerSpec?: string;
  
  supportedOs?: string[];
  
  recommendedUseCases?: string[];
  
  vendorExtensions?: Record<string, unknown>;
}


/** Reference to the source of a knowledge record (URL, repo, commit, doc version). @public */
export interface KnowledgeSourceRef {
  type: string;
  url?: string;
  repo?: string;
  commit?: string;
  documentVersion?: string;
  retrievedAt?: string;
}


/** Scope constraints for when a knowledge record applies (platforms, boards, SoCs, OS, toolchains). @public */
export interface KnowledgeCompatibilityScope {
  platforms?: string[];
  boards?: string[];
  socs?: string[];
  rdkVersions?: string[];
  osVersions?: string[];
  toolchains?: string[];
}


/** Chunking strategy for a knowledge record during retrieval. @public */
export interface KnowledgeChunkPolicy {
  strategy: 'none' | 'heading' | 'paragraph' | 'qa' | 'command' | 'release-note';
  maxTokens?: number;
  overlapTokens?: number;
}


/** Metadata for a knowledge record: id, source, scope, status, confidence, citations. @public */
export interface KnowledgeRecordMetadata {
  id: string;
  source?: KnowledgeSourceRef;
  scope?: KnowledgeCompatibilityScope;
  status?: string;
  confidence?: string;
  priority?: number;
  lastReviewedAt?: string;
  validFrom?: string;
  validTo?: string;
  supersedes?: string[];
  citationLabel?: string;
  chunkPolicy?: KnowledgeChunkPolicy;
}





/** An entry in a documentation index: title, URL, section, tags, metadata. @public */
export interface DocIndexEntry {
  
  title: string;
  
  url: string;
  
  section: string;
  
  tags: string[];
  
  metadata?: KnowledgeRecordMetadata;
}








/** A prompt fragment injected into the LLM context: section, tier, mode, content, priority. @public */
export interface PromptFragment {
  
  id: string;
  







  section:
    | 'persona'
    | 'reasoning'
    | 'tool_contract'
    | 'search_trigger'
    | 'ecosystem'
    | 'collaboration';
  
  tier: 'all' | 'large' | 'medium' | 'small';
  
  mode: 'all' | 'quick' | 'thinking';
  
  content: string;
  
  priority: number;
  
  metadata?: KnowledgeRecordMetadata;
}









/** A recognized shell command pattern with category, description, and risk level. @public */
export interface CommandPattern {
  
  pattern: RegExp;
  
  category: string;
  
  description: string;
  
  riskLevel: 'safe' | 'moderate' | 'dangerous';
  
  metadata?: KnowledgeRecordMetadata;
}











/** A failure hint matching an error pattern and suggesting a fix or doc URL. @public */
export interface FailureHint {
  
  errorPattern: RegExp;
  
  suggestion: string;
  
  docUrl?: string;
  
  metadata?: KnowledgeRecordMetadata;
}















/** Reference to an endorsed skill for a knowledge module. @public */
export interface EndorsedSkillRef {
  



  id: string;
  
  category?: string;
  



  platforms?: string[];
  





  priority?: number;
  
  metadata?: KnowledgeRecordMetadata;
}


/** The core knowledge module contract: device profiles, doc index, prompt fragments, command patterns, failure hints, ecosystem prompt, and skills. @public */
export interface KnowledgeModule {
  id: string;
  name: string;
  version: string;
  description: string;

  
  platforms: string[];

  




  platformClaimPriority?: number;

  















  family?: DeviceFamily;

  













  dependencies?: string[];

  
  getDeviceProfiles(): Record<string, DeviceProfileBase>;

  
  getDocIndex(): DocIndexEntry[];

  
  getPromptFragments(): PromptFragment[];

  
  getCommandPatterns(): CommandPattern[];

  
  getFailureHints(): FailureHint[];

  
  getEcosystemPrompt(): string;

  
  getResearchSeeds?(platform: string): string[];

  












  getSkills?(): EndorsedSkillRef[];
}
