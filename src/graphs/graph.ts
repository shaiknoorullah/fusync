import { Task } from "../interfaces/task.interface";
import { GraphNode } from "./graphNode";

export class Graph {
    nodes: Map<string, GraphNode> = new Map();

    addTask(task: Task): void {
        let node = this.nodes.get(task.id);
        if (!node) {
            node = new GraphNode(task);
            this.nodes.set(task.id, node);
        }

        if (task.dependencies) {
            task.dependencies.forEach((depId) => {
                let depNode = this.nodes.get(depId);
                if (!depNode) {
                    throw new Error(`Dependency ${depId} not found for task ${task.id}`);
                }
                node!.dependencies.push(depNode);
                depNode.dependents.push(node!);
                node!.inDegree++;
            });
        }
    }
}
