export type TuiRunState = 'ready' | 'running' | 'approval';

export interface AttachmentRef {
  index: number;
  kind: 'image' | 'file';
  label: string;
}
