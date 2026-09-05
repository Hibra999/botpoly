/**
 * Dashboard Module Exports
 */

export { startDashboard, stopDashboard } from './server.js';
export { DashboardEmitter } from './state-emitter.js';
export type {
  BotState,
  BotConfig,
  LogEntry,
  LogLevel,
  DashboardData,
  WebSocketMessage,
} from './types.js';

export { dashboardEmitter } from './state-emitter.js';
