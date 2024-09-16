// taskExecutionSystem.ts

// Import necessary modules
import chalk from "chalk";
import * as opentelemetry from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  SimpleSpanProcessor,
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import axios from "axios";

// Set up OpenTelemetry with custom InMemorySpanExporter
class InMemorySpanExporter implements SpanExporter {
  public spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: any) => void): void {
    this.spans.push(...spans);
    resultCallback({ code: 0 }); // 0 indicates success
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const provider = new NodeTracerProvider();
const exporter = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor(exporter);
provider.addSpanProcessor(processor);
provider.register();

const tracer = opentelemetry.trace.getTracer("task-execution-system");

// Interfaces
interface Task {
  id: string;
  action: (...args: any[]) => Promise<any> | any;
  dependencies?: string[];
  artifact?: any;
  retryCount?: number;
  retryDelay?: number;
  onError?: "continue" | "abort";
  priority?: number;
  metrics?: ExecutionMetrics;
  status?: "success" | "failed";
}

interface ExecutionMetrics {
  startTime: number;
  endTime: number;
  duration: number;
}

interface SequenceConfig {
  verbose?: boolean;
  maxConcurrency?: number;
}

interface LayerConfig {
  name: string;
  execute: (...args: any[]) => Promise<any> | any;
  dependsOn?: string[];
  retries?: number;
  retryDelay?: number;
  onError?: "continue" | "abort";
  priority?: number;
}

// Logging function
function log(
  type: "info" | "success" | "warning" | "error",
  message: string,
  data?: any,
  executionStart?: number
) {
  const timestamp = new Date().toISOString();
  const timeSinceStart = executionStart
    ? `+${((Date.now() - executionStart) / 1000).toFixed(3)}s`
    : "";
  let coloredMessage: string;

  switch (type) {
    case "info":
      coloredMessage = chalk.blue(message);
      break;
    case "success":
      coloredMessage = chalk.green(message);
      break;
    case "warning":
      coloredMessage = chalk.yellow(message);
      break;
    case "error":
      coloredMessage = chalk.red(message);
      break;
    default:
      coloredMessage = message;
  }

  console.log(`[${timestamp} ${timeSinceStart}] ${coloredMessage}`);
  if (data) {
    console.log(chalk.cyan(JSON.stringify(data, null, 2)));
  }
}

// Delay function
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GraphNode and Graph classes for DAG
class GraphNode {
  id: string;
  task: Task;
  dependencies: GraphNode[] = [];
  dependents: GraphNode[] = [];
  inDegree: number = 0;

  constructor(task: Task) {
    this.id = task.id;
    this.task = task;
  }
}

class Graph {
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

// Topological sort with priority
function topologicalSortWithPriority(graph: Graph): GraphNode[] {
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

// Semaphore class for concurrency control
class Semaphore {
  private tasks: (() => void)[] = [];
  private counter: number;

  constructor(private maxConcurrency: number) {
    this.counter = maxConcurrency;
  }

  async acquire(): Promise<void> {
    if (this.counter > 0) {
      this.counter--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.tasks.push(resolve));
  }

  release(): void {
    this.counter++;
    if (this.tasks.length > 0) {
      const nextTask = this.tasks.shift()!;
      this.counter--;
      nextTask();
    }
  }
}

// Execution functions
async function executeTaskWithRetries(
  task: Task,
  args: any[],
  executionStart: number
): Promise<any> {
  return tracer.startActiveSpan(`Task ${task.id}`, async (span) => {
    let attempts = 0;
    const maxAttempts = task.retryCount ?? 0;
    const retryDelay = task.retryDelay ?? 0;

    while (attempts <= maxAttempts) {
      try {
        log("info", `Starting Task ${task.id}`, args, executionStart);
        const startTime = Date.now();

        const result = await Promise.resolve(task.action(...args));

        const endTime = Date.now();
        task.metrics = {
          startTime,
          endTime,
          duration: endTime - startTime,
        };
        task.status = "success";

        log("success", `Completed Task ${task.id}`, result, executionStart);

        span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
        return result;
      } catch (error: any) {
        attempts++;
        span.addEvent(`Attempt ${attempts} failed: ${error.message}`);
        if (attempts > maxAttempts) {
          span.setStatus({
            code: opentelemetry.SpanStatusCode.ERROR,
            message: error.message,
          });
          log(
            "error",
            `Task ${task.id} failed after retries`,
            null,
            executionStart
          );
          task.status = "failed";
          throw error;
        }
        log(
          "warning",
          `Task ${task.id} failed on attempt ${attempts}: ${error.message}`,
          null,
          executionStart
        );
        log(
          "info",
          `Retrying Task ${task.id} in ${retryDelay}ms`,
          null,
          executionStart
        );
        await delay(retryDelay);
      } finally {
        span.end();
      }
    }
  });
}

async function executeTasksWithConcurrencyLimit(
  sortedNodes: GraphNode[],
  maxConcurrency: number,
  executionStart: number
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
              executionStart
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

// Timeline generation function
function generateTimeline(tasks: Task[], executionStart: number) {
  console.log(chalk.magenta("\n--- Execution Timeline ---\n"));
  const sortedTasks = tasks
    .filter((task) => task.metrics)
    .sort((a, b) => a.metrics!.startTime - b.metrics!.startTime);

  const totalDuration =
    sortedTasks[sortedTasks.length - 1].metrics!.endTime - executionStart;

  const terminalWidth = process.stdout.columns || 80;
  const padding = 2;
  const availableWidth = terminalWidth - padding * 2;

  // Calculate the width of the first column
  const maxNameLength = Math.max(...sortedTasks.map((task) => task.id.length));
  const nameColumnWidth = maxNameLength + 5;

  // Calculate widths for progress bar and time columns
  const remainingWidth = availableWidth - nameColumnWidth - 3; // 3 for border characters
  const progressBarWidth = Math.floor(remainingWidth * 0.7);
  const timeColumnWidth = remainingWidth - progressBarWidth;

  let output = "\n" + "─".repeat(terminalWidth) + "\n";
  output += `${" ".repeat(padding)}${"Task Name".padEnd(
    nameColumnWidth
  )}│${"Progress".padEnd(progressBarWidth)}│${"Execution Time".padEnd(
    timeColumnWidth
  )}${" ".repeat(padding)}\n`;
  output += "─".repeat(terminalWidth) + "\n";

  const startTime = sortedTasks[0].metrics!.startTime;

  sortedTasks.forEach((task) => {
    const metric = task.metrics!;
    const startOffset = Math.floor(
      ((metric.startTime - startTime) / totalDuration) * progressBarWidth
    );
    const duration = Math.max(
      1,
      Math.floor((metric.duration / totalDuration) * progressBarWidth)
    );

    const nameColumn = task.id.padEnd(nameColumnWidth);
    const progressBar =
      " ".repeat(startOffset) +
      "█".repeat(duration).padEnd(progressBarWidth - startOffset);

    const startStr = `+${((metric.startTime - executionStart) / 1000).toFixed(
      3
    )}s`;
    const endStr = `+${((metric.endTime - executionStart) / 1000).toFixed(3)}s`;
    const durationStr = `(${(metric.duration / 1000).toFixed(3)}s)`;
    const timeColumn = `${startStr} to ${endStr} ${durationStr}`.padEnd(
      timeColumnWidth
    );

    output += `${" ".repeat(
      padding
    )}${nameColumn}│${progressBar}│${timeColumn}${" ".repeat(padding)}\n`;
  });

  output += "─".repeat(terminalWidth) + "\n";

  console.log(chalk.yellow(output));
}

// Trace visualization function
function visualizeTraces() {
  console.log(chalk.magenta("\n--- Trace Hierarchy ---\n"));

  // Build a map of spans by their span ID
  const spansById = new Map<string, ReadableSpan>();
  exporter.spans.forEach((span) => {
    spansById.set(span.spanContext().spanId, span);
  });

  // Build the tree of spans
  const rootSpans: ReadableSpan[] = [];
  const spanChildrenMap = new Map<string, ReadableSpan[]>();

  exporter.spans.forEach((span) => {
    const parentId = span.parentSpanId;
    if (parentId && spansById.has(parentId)) {
      const siblings = spanChildrenMap.get(parentId) || [];
      siblings.push(span);
      spanChildrenMap.set(parentId, siblings);
    } else {
      rootSpans.push(span);
    }
  });

  // Function to recursively display spans
  function displaySpan(span: ReadableSpan, indent: string) {
    const duration =
      (span.endTime[0] - span.startTime[0]) * 1e3 +
      (span.endTime[1] - span.startTime[1]) / 1e6;

    console.log(
      `${indent}${chalk.blue(span.name)} ${chalk.gray(
        `(${duration.toFixed(2)}ms)`
      )}`
    );

    const children = spanChildrenMap.get(span.spanContext().spanId) || [];
    children.forEach((childSpan) => {
      displaySpan(childSpan, indent + "  ");
    });
  }

  // Display the trace hierarchy
  rootSpans.forEach((rootSpan) => {
    displaySpan(rootSpan, "");
  });

  console.log(chalk.magenta("\n--- End of Trace Hierarchy ---\n"));
}

// Function to assign levels to nodes
function assignLevels(graph: Graph): Map<string, number> {
  const levels = new Map<string, number>();
  const sortedNodes = topologicalSortWithPriority(graph);

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

// Function to visualize the graph with colors and rounded nodes
function visualizeGraph(graph: Graph): void {
  const levels = assignLevels(graph);

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
  const maxLevel = Math.max(...levels.values());
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

// Sequence class
class Sequence {
  private dag: Graph;
  private tasks: Task[] = [];
  private config: SequenceConfig;
  public context: Record<string, any> = {};
  private executionStart: number = 0;

  constructor(config: SequenceConfig) {
    this.dag = new Graph();
    this.config = config;
  }

  addLayer(taskConfig: LayerConfig): this {
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

  async build(): Promise<void> {
    // Build the DAG
    this.tasks.forEach((task) => this.dag.addTask(task));

    // Perform topological sort with priority
    const sortedNodes = topologicalSortWithPriority(this.dag);

    // Start execution
    this.executionStart = Date.now();

    // Use tracing
    const executionStart = this.executionStart;
    const tasks = this.tasks;

    await tracer.startActiveSpan("Execute Sequence", async (mainSpan) => {
      try {
        await executeTasksWithConcurrencyLimit(
          sortedNodes,
          this.config.maxConcurrency ?? 2,
          executionStart
        );
        mainSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
        log("success", "Sequence execution completed.", null, executionStart);
        generateTimeline(tasks, executionStart);
        this.logPerformanceMetrics();
        visualizeTraces(); // Visualize the trace hierarchy
      } catch (error: any) {
        mainSpan.setStatus({
          code: opentelemetry.SpanStatusCode.ERROR,
          message: error.message,
        });
        log(
          "error",
          `Error during sequence execution: ${error.message}`,
          null,
          executionStart
        );
      } finally {
        mainSpan.end();
      }
    });
  }

  // Method to log overall performance metrics
  private logPerformanceMetrics() {
    const successfulTasks = this.tasks.filter(
      (task) => task.status === "success"
    );
    const failedTasks = this.tasks.filter((task) => task.status === "failed");
    const totalTasks = this.tasks.length;
    const totalDuration = Date.now() - this.executionStart;

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

// Example tasks with API calls and dependency logging
const taskFetchUser: LayerConfig = {
  name: "FetchUser",
  execute: async () => {
    console.log("Fetching user data from API...");
    const response = await axios.get(
      "https://jsonplaceholder.typicode.com/users/1"
    );
    return response.data;
  },
  priority: 1,
};

const taskFetchPosts: LayerConfig = {
  name: "FetchPosts",
  execute: async () => {
    console.log("Fetching posts from API...");
    const response = await axios.get(
      "https://jsonplaceholder.typicode.com/posts"
    );
    return response.data;
  },
  priority: 1,
};

const taskProcessUserData: LayerConfig = {
  name: "ProcessUserData",
  execute: async (userData: any) => {
    console.log("Processing user data...");
    console.log("Received user data:", userData);
    // Simulate processing time
    await delay(500);
    const processedUser = {
      id: userData.id,
      name: userData.name.toUpperCase(),
      email: userData.email,
    };
    console.log("Processed user data:", processedUser);
    return processedUser;
  },
  dependsOn: ["FetchUser"],
  priority: 2,
};

const taskProcessPosts: LayerConfig = {
  name: "ProcessPosts",
  execute: async (posts: any) => {
    console.log("Processing posts...");
    console.log("Received posts:", posts.slice(0, 2)); // Log first 2 posts
    // Simulate processing time
    await delay(700);
    const processedPosts = posts.filter((post: any) => post.userId === 1);
    console.log("Processed posts:", processedPosts.slice(0, 2)); // Log first 2 processed posts
    return processedPosts;
  },
  dependsOn: ["FetchPosts"],
  priority: 2,
};

const taskAggregateData: LayerConfig = {
  name: "AggregateData",
  execute: async (processedUser: any, processedPosts: any) => {
    console.log("Aggregating data...");
    console.log("User data:", processedUser);
    console.log("Posts data:", processedPosts.slice(0, 2)); // Log first 2 posts
    // Simulate processing time
    await delay(600);
    const aggregatedData = {
      user: processedUser,
      posts: processedPosts,
    };
    console.log("Aggregated data:", aggregatedData);
    return aggregatedData;
  },
  dependsOn: ["ProcessUserData", "ProcessPosts"],
  priority: 3,
};

const taskStoreData: LayerConfig = {
  name: "StoreData",
  execute: async (aggregatedData: any) => {
    console.log("Storing data...");
    console.log("Data to store:", aggregatedData);
    // Simulate storage time
    await delay(400);
    return { status: "Data stored successfully", data: aggregatedData };
  },
  dependsOn: ["AggregateData"],
  priority: 4,
};

const taskSendNotification: LayerConfig = {
  name: "SendNotification",
  execute: async (storeResult: any) => {
    console.log("Sending notification...");
    console.log("Store result:", storeResult);
    // Simulate sending notification
    await delay(300);
    return { status: "Notification sent", result: storeResult };
  },
  dependsOn: ["StoreData"],
  priority: 5,
};

// Run the sequence
(async () => {
  const sequence = new Sequence({
    verbose: true,
    maxConcurrency: 3, // Increased concurrency
  });

  sequence
    .addLayer(taskFetchUser)
    .addLayer(taskFetchPosts)
    .addLayer(taskProcessUserData)
    .addLayer(taskProcessPosts)
    .addLayer(taskAggregateData)
    .addLayer(taskStoreData)
    .addLayer(taskSendNotification);

  visualizeGraph(sequence["dag"]);
  try {
    await sequence.build();
    console.log("Final context:", sequence.context);
  } catch (error) {
    console.error("Error during sequence execution:", error);
  }
})();
