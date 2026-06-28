










import type { DeviceFamily } from './device-family.js';





export interface CameraInterface {
  
  type: 'usb' | 'mipi' | 'gmsl' | 'other';
  
  count: number;
  
  notes?: string;
}





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


export interface KnowledgeSourceRef {
  type: string;
  url?: string;
  repo?: string;
  commit?: string;
  documentVersion?: string;
  retrievedAt?: string;
}


export interface KnowledgeCompatibilityScope {
  platforms?: string[];
  boards?: string[];
  socs?: string[];
  rdkVersions?: string[];
  osVersions?: string[];
  toolchains?: string[];
}


export interface KnowledgeChunkPolicy {
  strategy: 'none' | 'heading' | 'paragraph' | 'qa' | 'command' | 'release-note';
  maxTokens?: number;
  overlapTokens?: number;
}


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





export interface DocIndexEntry {
  
  title: string;
  
  url: string;
  
  section: string;
  
  tags: string[];
  
  metadata?: KnowledgeRecordMetadata;
}








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









export interface CommandPattern {
  
  pattern: RegExp;
  
  category: string;
  
  description: string;
  
  riskLevel: 'safe' | 'moderate' | 'dangerous';
  
  metadata?: KnowledgeRecordMetadata;
}











export interface FailureHint {
  
  errorPattern: RegExp;
  
  suggestion: string;
  
  docUrl?: string;
  
  metadata?: KnowledgeRecordMetadata;
}















export interface EndorsedSkillRef {
  



  id: string;
  
  category?: string;
  



  platforms?: string[];
  





  priority?: number;
  
  metadata?: KnowledgeRecordMetadata;
}


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
