import { AgentToolRegistry } from './tool-registry.js';
import { buildAIScanToolSpecs } from './tools/ai-scan-tools.js';
import { buildMobileScanToolSpecs } from './tools/mobile-scan-tools.js';
import { buildBusinessLearningToolSpecs } from './tools/business-learning-tools.js';
import { buildBusinessExperimentToolSpecs, buildBusinessFlowToolSpecs } from './tools/business-agent-tools.js';
import { buildNativeAssetToolSpecs } from './tools/native-asset-tools.js';
import { buildAndroidBusinessToolSpecs } from './tools/android-business-tools.js';

export function createAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  for (const tool of buildAIScanToolSpecs()) {
    registry.register(tool);
  }
  for (const tool of buildMobileScanToolSpecs()) {
    registry.register(tool);
  }
  for (const tool of buildAndroidBusinessToolSpecs()) {
    registry.register(tool);
  }
  for (const tool of buildBusinessLearningToolSpecs()) {
    registry.register(tool);
  }
  for (const tool of buildBusinessFlowToolSpecs()) {
    registry.register(tool);
  }
  for (const tool of buildBusinessExperimentToolSpecs()) {
    registry.register(tool);
  }
  for (const tool of buildNativeAssetToolSpecs()) {
    registry.register(tool);
  }
  return registry;
}
