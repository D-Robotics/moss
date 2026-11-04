/**
 * Compatibility shim: the spill implementation lives in the context layer so the
 * agent loop (core) can give every truncated tool result a recovery path without
 * importing tool implementations. Tool code keeps importing this path.
 */
export * from '../context/tool-output-spill.js';
