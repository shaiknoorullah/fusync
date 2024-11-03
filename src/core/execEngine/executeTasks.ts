import { GraphNode } from "../../graphs/graphNode";
import { Semaphore } from "../Semaphore";
import { executeTaskWithRetries } from "./executeTask";
import * as opentelemetry from '@opentelemetry/api'

export
  async function executeTasksWithConcurrencyLimit(
    sortedNodes: GraphNode[],
    maxConcurrency: number,
    executionStart: number,
    tracer: opentelemetry.Tracer
  ): Promise<void> {
  const nodeLevels = new Map<GraphNode, number>();
  const semaphore = new Semaphore(maxConcurrency);

  // Assign levels to nodes based on their dependencies
  sortedNodes.forEach((node) => {
    let level = 0;
    if (node.dependencies.length > 0) {
      level =
        Math.max(...node.dependencies.map((dep) => nodeLevels.get(dep)!)) + 1;
    }
    nodeLevels.set(node, level);
  });

  const maxLevel = Math.max(...nodeLevels.values());

  for (let level = 0; level <= maxLevel; level++) {
    const nodesAtLevel = sortedNodes.filter(
      (node) => nodeLevels.get(node) === level
    );
    await Promise.all(
      nodesAtLevel.map(async (node) => {
        await semaphore.acquire();
        try {
          let dependencyResults: any[] = [];
          if (node.dependencies.length > 0) {
            dependencyResults = node.dependencies.map(
              (depNode) => depNode.task.artifact
            );
          }
          // Execute the action with dependency results
          try {
            const result = await executeTaskWithRetries(
              node.task,
              dependencyResults,
              executionStart,
              tracer
            );
            // Store the artifact for dependents to use
            node.task.artifact = result;
          } catch (error) {
            if (node.task.onError === "abort") {
              throw new Error(
                `Aborting execution due to failure in task ${node.id}`
              );
            } else {
              // Continue execution without setting the artifact
              node.task.artifact = null;
            }
          }
        } finally {
          semaphore.release();
        }
      })
    );
  }
}