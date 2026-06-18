import { AgentToolRegistry } from './tool-registry.js';
import { buildAIScanToolSpecs } from './tools/ai-scan-tools.js';

export function createAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  for (const tool of buildAIScanToolSpecs()) {
    registry.register(tool);
  }
  return registry;
}
