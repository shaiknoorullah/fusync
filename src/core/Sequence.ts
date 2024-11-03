import chalk from "chalk";
import { Graph } from "../graphs/graph";
import { LayerConfig } from "../interfaces/layerConfig.interface";
import { SequenceConfig } from "../interfaces/sequenceConfig.interface";
import { Task } from "../interfaces/task.interface";
import { generateTimeline } from "../utils/log-utils/genTimeline";
import { log } from "../utils/log-utils/logger";
import { InitializeTracer } from "../utils/open-telemetry/instrumentation";
import { executeTasksWithConcurrencyLimit } from "./execEngine/executeTasks";
import * as opentelemetry from '@opentelemetry/api'
import { GraphNode } from "../graphs/graphNode";

export class Sequence {
    private graph: Graph
    private tasks: Task[] = [];
    private config: SequenceConfig;
    private executionStart: number = 0;
    private traceProvider: InitializeTracer
    private tracer: opentelemetry.Tracer
    private sortedNodes: GraphNode[] = []
    public context: Record<string, any> = {};


    constructor(config: SequenceConfig) {
        this.graph = new Graph()
        this.config = config;
        this.traceProvider = new InitializeTracer()
        this.tracer = this.traceProvider.getTracer()
    }

    public addLayer(taskConfig: LayerConfig): this {
        const task: Task = {
            id: taskConfig.name,
            action: taskConfig.execute,
            dependencies: taskConfig.dependsOn,
            retryCount: taskConfig.retries,
            retryDelay: taskConfig.retryDelay,
            onError: taskConfig.onError,
            priority: taskConfig.priority,
        };
        this.tasks.push(task);
        return this;
    }

    private addTasksToGraph(): void {
        if (this.tasks.length === 0) {
            console.log("ERROR:\n No tasks to add.")
        }
        // Build the DAG
        this.tasks.forEach((task) => this.graph.addTask(task));
    }
    private sortNodes(): void {
        if (this.sortedNodes.length === 0) {
            console.log("ERROR:\n No nodes to sort.")
        }
        // Perform topological sort with priority
        this.sortedNodes = this.topologicalSortWithPriority(this.graph);
    }

    private topologicalSortWithPriority = (graph: Graph): GraphNode[] => {
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

    public async build(): Promise<void> {
        this.addTasksToGraph()
        this.sortNodes()

        // Start execution
        this.executionStart = Date.now();

        // Use tracing
        const tasks = this.tasks;

        await this.tracer.startActiveSpan("Execute Sequence", async (mainSpan) => {
            try {
                await executeTasksWithConcurrencyLimit(
                    this.sortedNodes,
                    this.config.maxConcurrency ?? 2,
                    this.executionStart,
                    this.tracer
                );
                mainSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
                log("success", "Sequence execution completed.", null, this.executionStart);
                generateTimeline(tasks, this.executionStart);
                this.traceProvider.logPerformanceMetrics(tasks, this.executionStart);
                //   visualizeTraces(); // Visualize the trace hierarchy
                this.traceProvider.visualizeTraces()
            } catch (error: any) {
                mainSpan.setStatus({
                    code: opentelemetry.SpanStatusCode.ERROR,
                    message: error.message,
                });
                log(
                    "error",
                    `Error during sequence execution: ${error.message}`,
                    null,
                    this.executionStart
                );
            } finally {
                mainSpan.end();
            }
        });
    }
}
