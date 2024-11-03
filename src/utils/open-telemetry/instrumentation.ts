import * as opentelemetry from '@opentelemetry/api'
import { NodeTracerProvider, ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter } from "./inMemSpanExporter";
import chalk from 'chalk';
import { Graph } from '../../graphs/graph';
import { GraphNode } from '../../graphs/graphNode';
import { Task } from '../../interfaces/task.interface';
import { topologicalSort } from '../topologicalSort';


export class InitializeTracer {
    private provider = new NodeTracerProvider()
    private exporter = new InMemorySpanExporter()
    private processor = new SimpleSpanProcessor(this.exporter)
    private tracer: opentelemetry.Tracer
    private spansById: Map<string, ReadableSpan>
    private rootSpans: ReadableSpan[]
    private spanChildrenMap

    constructor() {
        this.tracer = opentelemetry.trace.getTracer("task-execution-system")
        this.provider.addSpanProcessor(this.processor)
        this.provider.register()
        // create a map of spans with their span id Map(spanId,span)
        this.spansById = new Map<string, ReadableSpan>();

        // set an empty array to store root spans
        this.rootSpans = [];

        // create a new map to store all children of a span
        this.spanChildrenMap = new Map<string, ReadableSpan[]>();
    }

    private assignLevels = (graph: Graph): Map<string, number> => {
        const levels = new Map<string, number>();
        const sortedNodes = topologicalSort(graph);

        sortedNodes.forEach((node) => {
            if (node.dependencies.length === 0) {
                levels.set(node.id, 0);
            } else {
                const maxLevel = Math.max(
                    ...node.dependencies.map((dep) => levels.get(dep.id)! + 1)
                );
                levels.set(node.id, maxLevel);
            }
        });

        return levels;
    }

    // Build a map of spans by their span ID
    private createSpantoSpanIdMap = () => {
        this.exporter.spans.forEach((span) => {
            this.spansById.set(span.spanContext().spanId, span);
        });
    }

    // Build the tree of spans
    private buildSpanTree = () => {
        this.exporter.spans.forEach((span) => {
            const parentId = span.parentSpanId;
            if (parentId && this.spansById.has(parentId)) {
                const siblings = this.spanChildrenMap.get(parentId) || [];
                siblings.push(span);
                this.spanChildrenMap.set(parentId, siblings);
            } else {
                this.rootSpans.push(span);
            }
        });
    }

    // Function to recursively display spans
    private displaySpan = (span: ReadableSpan, indent: string) => {
        const duration =
            (span.endTime[0] - span.startTime[0]) * 1e3 +
            (span.endTime[1] - span.startTime[1]) / 1e6;

        console.log(
            `${indent}${chalk.blue(span.name)} ${chalk.gray(
                `(${duration.toFixed(2)}ms)`
            )}`
        );

        const children = this.spanChildrenMap.get(span.spanContext().spanId) || [];
        children.forEach((childSpan) => {
            this.displaySpan(childSpan, indent + "  ");
        });
    }

    public visualizeTraces = () => {
        this.createSpantoSpanIdMap()
        this.buildSpanTree()
        console.log(chalk.magenta("\n--- Trace Hierarchy ---\n"));

        // Display the trace hierarchy
        this.rootSpans.forEach((rootSpan) => {
            this.displaySpan(rootSpan, "");
        });

        console.log(chalk.magenta("\n--- End of Trace Hierarchy ---\n"));
    }

    public visualizeGraph(graph: Graph): void {
        const levels = this.assignLevels(graph);

        // Group nodes by level
        const levelNodes: Map<number, GraphNode[]> = new Map();
        levels.forEach((level, nodeId) => {
            const node = graph.nodes.get(nodeId)!;
            if (!levelNodes.has(level)) {
                levelNodes.set(level, []);
            }
            levelNodes.get(level)!.push(node);
        });

        // Determine canvas dimensions
        const maxLevel = Math.max(...levels.values()); // select the max value from all values in the levels Map.
        const width = 80;
        const height = (maxLevel + 1) * 6; // Increased spacing for larger nodes
        const canvas: string[][] = Array.from({ length: height }, () =>
            Array.from({ length: width }, () => " ")
        );

        // Map to store node positions
        const nodePositions: Map<string, { x: number; y: number }> = new Map();

        // Function to draw a colored box with rounded corners
        function drawNode(
            x: number,
            y: number,
            width: number,
            height: number,
            text: string,
            colorFn: (str: string) => string
        ) {
            const lines = [];

            // Top border
            let topBorder = "╭" + "─".repeat(width - 2) + "╮";
            lines.push(topBorder);

            // Empty lines
            const emptyLinesCount = height - 2;
            const textLineIndex = Math.floor(emptyLinesCount / 2);

            for (let i = 0; i < emptyLinesCount; i++) {
                if (i === textLineIndex) {
                    // Center the text
                    const padding = width - 2 - text.length;
                    const leftPadding = Math.floor(padding / 2);
                    const rightPadding = padding - leftPadding;
                    let line =
                        "│" + " ".repeat(leftPadding) + text + " ".repeat(rightPadding) + "│";
                    lines.push(line);
                } else {
                    lines.push("│" + " ".repeat(width - 2) + "│");
                }
            }

            // Bottom border
            let bottomBorder = "╰" + "─".repeat(width - 2) + "╯";
            lines.push(bottomBorder);

            // Draw lines onto the canvas
            for (let i = 0; i < lines.length; i++) {
                const line = colorFn(lines[i]);
                const chars = line.split("");
                for (let j = 0; j < chars.length; j++) {
                    if (
                        x - Math.floor(width / 2) + j >= 0 &&
                        x - Math.floor(width / 2) + j < canvas[0].length &&
                        y - Math.floor(lines.length / 2) + i >= 0 &&
                        y - Math.floor(lines.length / 2) + i < canvas.length
                    ) {
                        canvas[y - Math.floor(lines.length / 2) + i][
                            x - Math.floor(width / 2) + j
                        ] = chars[j];
                    }
                }
            }
        }

        // Assign colors to nodes
        const colors = [
            chalk.red,
            chalk.green,
            chalk.blue,
            chalk.yellow,
            chalk.magenta,
            chalk.cyan,
            chalk.white,
        ];
        let colorIndex = 0;
        const nodeColors: Map<string, (str: string) => string> = new Map();

        graph.nodes.forEach((node) => {
            nodeColors.set(node.id, colors[colorIndex % colors.length]);
            colorIndex++;
        });

        // Place nodes on the canvas
        for (let level = 0; level <= maxLevel; level++) {
            const nodes = levelNodes.get(level)!;
            const y = level * 6 + 3; // Adjusted for larger nodes
            const spacing = Math.floor(width / (nodes.length + 1));

            nodes.forEach((node, index) => {
                const x = (index + 1) * spacing;
                const nodeWidth = 10;
                const nodeHeight = 5;
                const colorFn = nodeColors.get(node.id)!;
                drawNode(x, y, nodeWidth, nodeHeight, node.id, colorFn);
                nodePositions.set(node.id, { x, y });
            });
        }

        // Draw dependencies
        graph.nodes.forEach((node) => {
            const fromPos = nodePositions.get(node.id)!;
            node.dependencies.forEach((dep) => {
                const toPos = nodePositions.get(dep.id)!;

                // Draw lines using box-drawing characters
                const x1 = fromPos.x;
                const y1 = fromPos.y - 3; // Top of the node
                const x2 = toPos.x;
                const y2 = toPos.y + 3; // Bottom of the dependency node

                if (x1 === x2) {
                    // Vertical line
                    const yStart = Math.min(y1, y2);
                    const yEnd = Math.max(y1, y2);
                    for (let y = yStart + 1; y < yEnd; y++) {
                        if (y >= 0 && y < canvas.length) {
                            canvas[y][x1] = "│";
                        }
                    }
                } else {
                    // Vertical line from fromNode upwards
                    const yStart = y1;
                    const yEnd = y1 - 2;
                    for (let y = yEnd; y < yStart; y++) {
                        if (y >= 0 && y < canvas.length) {
                            canvas[y][x1] = "│";
                        }
                    }
                    // Horizontal line
                    const xStart = Math.min(x1, x2);
                    const xEnd = Math.max(x1, x2);
                    const y = y1 - 2;
                    for (let x = xStart + 1; x < xEnd; x++) {
                        if (y >= 0 && y < canvas.length && x >= 0 && x < canvas[0].length) {
                            canvas[y][x] = "─";
                        }
                    }
                    // Vertical line down to toNode
                    const yStart2 = y2 + 2;
                    const yEnd2 = y2;
                    for (let y = yStart2; y > yEnd2; y--) {
                        if (y >= 0 && y < canvas.length) {
                            canvas[y][x2] = "│";
                        }
                    }
                    // Connectors
                    if (
                        y1 - 2 >= 0 &&
                        y1 - 2 < canvas.length &&
                        x2 >= 0 &&
                        x2 < canvas[0].length
                    ) {
                        canvas[y1 - 2][x2] = "┌";
                    }
                    if (
                        y2 + 2 >= 0 &&
                        y2 + 2 < canvas.length &&
                        x2 >= 0 &&
                        x2 < canvas[0].length
                    ) {
                        canvas[y2 + 2][x2] = "└";
                    }
                    if (
                        y1 - 2 >= 0 &&
                        y1 - 2 < canvas.length &&
                        x1 >= 0 &&
                        x1 < canvas[0].length
                    ) {
                        canvas[y1 - 2][x1] = x1 < x2 ? "┘" : "└";
                    }
                }
            });
        });

        // Print the canvas
        const output = canvas.map((row) => row.join("")).join("\n");
        console.log(output);
    }

    public getTracer = () => {
        return this.tracer
    }

    // Method to log overall performance metrics
    public logPerformanceMetrics(tasks: Task[], executionStart: number) {
        const successfulTasks = tasks.filter(
            (task) => task.status === "success"
        );
        const failedTasks = tasks.filter((task) => task.status === "failed");
        const totalTasks = tasks.length;
        const totalDuration = Date.now() - executionStart;

        const taskDurations = successfulTasks.map((task) => task.metrics!.duration);
        const averageTaskDuration =
            taskDurations.reduce((sum, duration) => sum + duration, 0) /
            taskDurations.length;

        const maxTaskDuration = Math.max(...taskDurations);
        const minTaskDuration = Math.min(...taskDurations);

        const successRate = (successfulTasks.length / totalTasks) * 100;

        console.log(
            chalk.green("\n--- Sequence Execution Performance Metrics ---\n")
        );
        console.log(
            `Total Execution Time: ${(totalDuration / 1000).toFixed(3)} seconds`
        );
        console.log(`Total Tasks: ${totalTasks}`);
        console.log(`Successful Tasks: ${successfulTasks.length}`);
        console.log(`Failed Tasks: ${failedTasks.length}`);
        console.log(`Success Rate: ${successRate.toFixed(2)}%`);
        console.log(
            `Average Task Duration: ${(averageTaskDuration / 1000).toFixed(
                3
            )} seconds`
        );
        console.log(
            `Maximum Task Duration: ${(maxTaskDuration / 1000).toFixed(3)} seconds`
        );
        console.log(
            `Minimum Task Duration: ${(minTaskDuration / 1000).toFixed(3)} seconds`
        );
    }
}