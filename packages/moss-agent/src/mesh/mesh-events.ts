











export interface MeshJoinedEvent {
  type: 'mesh_joined';
  peerId: string;
  peerName: string;
  capabilities: string[];
  deviceInfo: string;
  timestamp: number;
}

export interface MeshLeftEvent {
  type: 'mesh_left';
  peerId: string;
  reason: string;
  timestamp: number;
}



export interface ChildRunStartedEvent {
  type: 'child_run_started';
  runId: string;
  parentRunId: string;
  scope: string;
  toolSet: string[];
  timestamp: number;
}

export interface ChildRunProgressEvent {
  type: 'child_run_progress';
  runId: string;
  turn: number;
  toolCalls: string[];
  status: 'running' | 'waiting_for_tools' | 'summarizing';
  timestamp: number;
}

export interface ChildRunCompletedEvent {
  type: 'child_run_completed';
  runId: string;
  summary: string;
  toolResults: number;
  turns: number;
  durationMs: number;
  timestamp: number;
}

export interface ChildRunFailedEvent {
  type: 'child_run_failed';
  runId: string;
  error: string;
  category: string;
  timestamp: number;
}



export interface ApprovalRequestedEvent {
  type: 'approval_requested';
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  sideEffectClass: string;
  timestamp: number;
}



export interface CancellationPropagatedEvent {
  type: 'cancellation_propagated';
  runId: string;
  source: string;
  targetRuns: string[];
  timestamp: number;
}



export type MeshEvent =
  | MeshJoinedEvent
  | MeshLeftEvent
  | ChildRunStartedEvent
  | ChildRunProgressEvent
  | ChildRunCompletedEvent
  | ChildRunFailedEvent
  | ApprovalRequestedEvent
  | CancellationPropagatedEvent;



export interface MeshEventSink {
  emit(event: MeshEvent): void;
}





export class MeshEventBus implements MeshEventSink {
  private listeners: Array<(event: MeshEvent) => void> = [];

  emit(event: MeshEvent): void {
    
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        
      }
    }
  }

  on(listener: (event: MeshEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  
  clear(): void {
    this.listeners.length = 0;
  }
}
