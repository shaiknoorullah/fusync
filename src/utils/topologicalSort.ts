import { Graph } from "../graphs/graph";
import { GraphNode } from "../graphs/graphNode";

export const topologicalSort = (graph: Graph): GraphNode[] => {
    const sortedNodes: GraphNode[] = [];
    const queue: GraphNode[] = [];

    // Initialize queue with nodes having inDegree 0
    graph.nodes.forEach((node) => {
        if (node.inDegree === 0) {
            queue.push(node);
        }
    });

    while (queue.length > 0) {
        // Sort the queue based on priority (higher priority first)
        queue.sort((a, b) => (b.task.priority ?? 0) - (a.task.priority ?? 0));

        const node = queue.shift()!;
        sortedNodes.push(node);

        // Decrease inDegree of dependents
        node.dependents.forEach((dependent) => {
            dependent.inDegree--;
            if (dependent.inDegree === 0) {
                queue.push(dependent);
            }
        });
    }

    if (sortedNodes.length !== graph.nodes.size) {
        throw new Error(
            "Graph has at least one cycle; topological sort not possible."
        );
    }
    return sortedNodes;
}