import { AgentToolRegistry } from './tool-registry.js';
import { buildAIScanToolSpecs } from './tools/ai-scan-tools.js';
import { buildMobileScanToolSpecs } from './tools/mobile-scan-tools.js';

export function createAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  for (const tool of buildAIScanToolSpecs()) {
    registry.register(tool);
  }
  for (const tool of buildMobileScanToolSpecs()) {
    registry.register(tool);
  }
  return registry;
}
