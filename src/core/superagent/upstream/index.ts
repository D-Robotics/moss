/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.js';
export * from './ports.js';
export {
  Engine,
  type EngineForExecutor,
  type EngineForMainSession,
  type EngineForPeople,
  type EngineForSettings,
  type EngineForSources,
  type EngineOptions,
  type Outcome,
  type ReceiveResult,
  type Reply,
  type ReplyRequest,
  type WorkerReport,
} from './engine.js';
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.js';
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.js';
export { MemoryRepositories } from './memory.js';
export { canRetry, ticketStage, type TicketStage } from './stage.js';
export { key } from './ids.js';
