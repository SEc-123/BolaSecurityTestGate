import type { AIScanRepository } from '../services/ai-scan/repository.js';
import type { AIScanTask } from '../services/ai-scan/types.js';

/** Settle failed dependency chains before scheduling so campaign summaries can run. */
export async function blockFailedDependencies(repo: AIScanRepository, scanRunId: string): Promise<AIScanTask[]> {
  const tasks = await repo.listTasks(scanRunId);
  if (tasks.some(task => task.status === 'waiting_selection') || (await repo.getRun(scanRunId))?.status === 'awaiting_selection') return tasks;
  const byId = new Map(tasks.map(task => [task.id, task]));
  let changed: boolean;
  do {
    changed = false;
    for (const task of tasks) {
      if (task.status !== 'pending') continue;
      // The repository intentionally allows summaries to aggregate failed or
      // blocked children. They must remain eligible after this cascade settles.
      if (task.task_type === 'summarize_vulnerability_campaign' || task.execution_plan?.intent === 'summarize_vulnerability_campaign' ||
        task.execution_plan?.intent === 'review_business_flows') continue;
      const unsuccessful = task.dependencies.map(id => byId.get(id)).filter(dependency => dependency?.status === 'failed' || dependency?.status === 'blocked');
      if (unsuccessful.length === 0) continue;
      const patch = {
        status: 'blocked' as const,
        phase: 'dependency_failed',
        error_message: `Required dependencies did not complete successfully: ${unsuccessful.map(dependency => `${dependency!.id} (${dependency!.status})`).join(', ')}`,
        completed_at: new Date().toISOString(),
      };
      await repo.updateTask(task.id, patch);
      Object.assign(task, patch);
      changed = true;
    }
  } while (changed);
  return tasks;
}
