import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import * as opentelemetry from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { Queue, Worker, Job, RedisOptions } from "bullmq";
import { terminal } from "terminal-kit";
import axios from "axios";

// Set up OpenTelemetry
const provider = new NodeTracerProvider();
const exporter = new ConsoleSpanExporter();
const processor = new SimpleSpanProcessor(exporter);
provider.addSpanProcessor(processor);
provider.register();

const tracer = opentelemetry.trace.getTracer("advanced-sequence-builder");

interface LayerConfig {
  name: string;
  execute: (...args: any[]) => Promise<any>;
  args: string[];
  description?: string;
  dependsOn?: string[];
  retries?: number;
}

interface SequenceConfig {
  verbose: boolean;
  queueType: "FIFO" | "LIFO";
  useRedis: boolean;
  redisOptions?: RedisOptions;
  concurrency?: number;
}

interface ExecutionMetrics {
  startTime: number;
  endTime: number;
  duration: number;
}

class InMemoryQueue extends EventEmitter {
  private jobs: any[] = [];

  constructor(private queueType: "FIFO" | "LIFO") {
    super();
  }

  async add(name: string, data: any, opts?: any): Promise<Job> {
    const job = { id: opts?.jobId || uuidv4(), name, data };
    if (this.queueType === "FIFO") {
      this.jobs.push(job);
    } else {
      this.jobs.unshift(job);
    }
    this.emit("added", job);
    return job as Job;
  }

  async process(processor: (job: Job) => Promise<any>): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift() as Job;
      try {
        await processor(job);
        this.emit("completed", job);
      } catch (error) {
        this.emit("failed", job, error);
      }
    }
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.jobs.find((job) => job.id === jobId) || null;
  }

  async waitUntilReady(): Promise<void> {
    // No-op for in-memory queue
  }
}

function generateTimeline(
  metrics: Map<string, ExecutionMetrics>,
  totalDuration: number
): string {
  const terminalWidth = terminal.width || 80;
  const padding = 2;
  const availableWidth = terminalWidth - padding * 2;

  // Calculate the width of the first column
  const maxNameLength = Math.max(
    ...Array.from(metrics.keys()).map((name) => name.length)
  );
  const nameColumnWidth = maxNameLength + 5;

  // Calculate widths for progress bar and time columns
  const remainingWidth = availableWidth - nameColumnWidth - 3; // 3 for border characters
  const progressBarWidth = Math.floor(remainingWidth * 0.7);
  const timeColumnWidth = remainingWidth - progressBarWidth;

  let output = "\n" + "─".repeat(terminalWidth) + "\n";
  output += `${" ".repeat(padding)}${"Layer Name".padEnd(
    nameColumnWidth
  )}│${"Progress".padEnd(progressBarWidth)}│${"Execution Time".padEnd(
    timeColumnWidth
  )}${" ".repeat(padding)}\n`;
  output += "─".repeat(terminalWidth) + "\n";

  const sortedMetrics = Array.from(metrics.entries()).sort(
    (a, b) => a[1].startTime - b[1].startTime
  );
  const startTime = sortedMetrics[0][1].startTime;

  sortedMetrics.forEach(([name, metric]) => {
    const startOffset = Math.floor(
      ((metric.startTime - startTime) / totalDuration) * progressBarWidth
    );
    const duration = Math.max(
      1,
      Math.floor((metric.duration / totalDuration) * progressBarWidth)
    );

    const nameColumn = name.padEnd(nameColumnWidth);
    const progressBar =
      " ".repeat(startOffset) +
      "█".repeat(duration).padEnd(progressBarWidth - startOffset);

    const startStr = `+${((metric.startTime - startTime) / 1000).toFixed(3)}s`;
    const endStr = `+${((metric.endTime - startTime) / 1000).toFixed(3)}s`;
    const durationStr = `(${(metric.duration / 1000).toFixed(3)}s)`;
    const timeColumn = `${startStr} to ${endStr} ${durationStr}`.padEnd(
      timeColumnWidth
    );

    output += `${" ".repeat(
      padding
    )}${nameColumn}│${progressBar}│${timeColumn}${" ".repeat(padding)}\n`;
  });

  output += "─".repeat(terminalWidth) + "\n";

  return output;
}

class AdvancedSequenceBuilder {
  private layers: Map<string, LayerConfig> = new Map();
  private dependencies: Map<string, Set<string>> = new Map();
  public context: Record<string, any> = {};
  private queue: Queue | InMemoryQueue;
  private worker: Worker | null = null;
  private executionStart: number = 0;
  private metrics: Map<string, ExecutionMetrics> = new Map();
  private timeline: Record<
    string,
    { start: number | null; end: number | null }
  >;

  constructor(private config: SequenceConfig) {
    this.timeline = {};
    if (config.useRedis && config.redisOptions) {
      this.queue = new Queue("sequence-tasks", {
        connection: config.redisOptions,
      });
      this.worker = new Worker("sequence-tasks", this.processJob.bind(this), {
        connection: config.redisOptions,
        concurrency: config.concurrency || 5,
      });
      this.setupBullMQEvents();
    } else {
      this.queue = new InMemoryQueue(config.queueType);
      this.setupInMemoryQueueEvents();
    }
  }

  private setupBullMQEvents() {
    if (this.worker) {
      this.worker.on("completed", (job) => {
        this.log("success", `Job completed: ${job.name}`);
      });

      this.worker.on("failed", (job, error) => {
        if (job) {
          this.log("error", `Job failed: ${job.name}`, error);
        } else {
          this.log("error", "Job failed", error);
        }
      });
    }
  }

  private setupInMemoryQueueEvents() {
    (this.queue as InMemoryQueue).on("added", (job) => {
      this.log("info", `Job added to queue: ${job.name} [${job.id}]`);
    });

    (this.queue as InMemoryQueue).on("completed", (job) => {
      this.log("success", `Job completed: ${job.name} [${job.id}]`);
    });

    (this.queue as InMemoryQueue).on("failed", (job, error) => {
      this.log("error", `Job failed: ${job.name} [${job.id}]`, error);
    });
  }

  private log(
    type: "info" | "success" | "warning" | "error",
    message: string,
    data?: any
  ) {
    if (!this.config.verbose) return;

    const timestamp = new Date().toISOString();
    const timeSinceStart = this.executionStart
      ? `+${((Date.now() - this.executionStart) / 1000).toFixed(3)}s`
      : "";
    let coloredMessage;
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
    }
    console.log(`[LOG ${timestamp} ${timeSinceStart}] ${coloredMessage}`);
    if (data) {
      console.log(chalk.cyan(JSON.stringify(data, null, 2)));
    }
  }

  addLayer(config: LayerConfig): this {
    this.layers.set(config.name, config);
    if (config.dependsOn) {
      this.dependencies.set(config.name, new Set(config.dependsOn));
    }
    return this;
  }

  removeLayer(name: string): this {
    this.layers.delete(name);
    this.dependencies.delete(name);
    return this;
  }

  // async build(): Promise<void> {
  //     this.executionStart = Date.now();
  //     this.log('info', `Starting sequence execution (${this.config.useRedis ? 'Redis' : 'In-Memory'} mode)`);
  //     return new Promise((resolve, reject) => {
  //         tracer.startActiveSpan('Build Sequence', async (span) => {
  //             try {
  //                 const sortedLayers = this.topologicalSort();
  //                 await this.executeLayersInOrder(sortedLayers);
  //                 span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
  //                 this.logMetrics();
  //                 resolve();
  //             } catch (error) {
  //                 span.setStatus({
  //                     code: opentelemetry.SpanStatusCode.ERROR,
  //                     message: error instanceof Error ? error.message : 'Unknown error'
  //                 });
  //                 reject(error);
  //             } finally {
  //                 span.end();
  //                 if (this.worker) {
  //                     await this.worker.close();
  //                 }
  //                 if (this.queue instanceof Queue) {
  //                     await this.queue.close();
  //                 }
  //             }
  //         });
  //     });
  // }

  async build(): Promise<void> {
    this.executionStart = Date.now();
    this.log(
      "info",
      `Starting sequence execution (${
        this.config.useRedis ? "Redis" : "In-Memory"
      } mode)`
    );

    return new Promise(async (resolve, reject) => {
      await tracer.startActiveSpan("Build Sequence", async (span) => {
        try {
          const sortedLayers = this.topologicalSort();
          await this.executeLayersInOrder(sortedLayers);
          span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
          this.logMetrics();
          resolve();
        } catch (error) {
          span.setStatus({
            code: opentelemetry.SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Unknown error",
          });
          reject(error);
        } finally {
          span.end();
          await this.cleanup();
        }
      });
    });
  }

  private async cleanup() {
    if (this.worker) {
      await this.worker.close();
    }
    if (this.queue instanceof Queue) {
      await this.queue.close();
    }
  }

  private topologicalSort(): string[] {
    return tracer.startActiveSpan("Topological Sort", (span) => {
      const visited = new Set<string>();
      const result: string[] = [];

      const visit = (layerName: string) => {
        if (visited.has(layerName)) return;
        visited.add(layerName);

        const deps = this.dependencies.get(layerName) || new Set();
        for (const dep of deps) {
          visit(dep);
        }

        result.push(layerName);
      };

      for (const layerName of this.layers.keys()) {
        visit(layerName);
      }

      const sortedLayers = result.reverse();
      span.setAttributes({
        sortedLayers: sortedLayers.join(","),
      });
      span.end();
      this.log("info", `Layers sorted: ${sortedLayers.join(" -> ")}`);
      return sortedLayers;
    });
  }

  // private async executeLayersInOrder(sortedLayers: string[]): Promise<void> {
  //     const executionPromises = new Map<string, Promise<void>>();

  //     const executeLayer = async (layerName: string) => {
  //         const dependencies = this.dependencies.get(layerName) || new Set();
  //         await Promise.all(Array.from(dependencies).map(dep => executionPromises.get(dep)));

  //         if (this.config.useRedis) {
  //             await this.queue.add(layerName, { layerName, args: this.layers.get(layerName)?.args }, {
  //                 jobId: layerName,
  //                 attempts: this.layers.get(layerName)?.retries || 3,
  //                 backoff: {
  //                     type: 'exponential',
  //                     delay: 1000,
  //                 },
  //             });
  //         } else {
  //             await this.processJob({ name: layerName, data: { layerName } } as Job);
  //         }
  //     };

  //     const layerPromises = sortedLayers.map(layerName => {
  //         const promise = executeLayer(layerName);
  //         executionPromises.set(layerName, promise);
  //         return promise;
  //     });

  //     await Promise.all(layerPromises);

  //     if (this.config.useRedis) {
  //         await this.queue.waitUntilReady();
  //         await new Promise<void>(resolve => {
  //             this.worker!.on('drained', resolve);
  //         });
  //     }
  // }

  private simpleLog(message: string) {
    console.log(`[LOG ${new Date().toISOString()}] ${message}`);
  }

  private async executeLayersInOrder(sortedLayers: string[]): Promise<void> {
    const executionPromises = new Map<string, Promise<void>>();
    const executingTasks: Set<string> = new Set(); // To keep track of currently executing tasks

    // Function to execute each layer
    const executeLayer = async (layerName: string) => {
      const dependencies = this.dependencies.get(layerName) || new Set();

      // Wait for dependencies to finish before starting this layer
      await Promise.all(
        Array.from(dependencies).map((dep) => executionPromises.get(dep))
      );

      this.simpleLog(`Starting layer: ${layerName}`);
      const startTime = Date.now();

      try {
        // Process the layer
        const layer = this.layers.get(layerName);
        if (!layer) {
          throw new Error(`Layer ${layerName} not found`);
        }

        const args = layer.args.map((arg) => this.context[arg]); // Ensure the context values are properly passed

        const result = await layer.execute(...args);
        // Ensure context updates happen synchronously
        this.context[layerName] = result; // Update context with layer result if needed

        const endTime = Date.now();
        const duration = endTime - startTime;

        // Update the metrics with timing data
        this.metrics.set(layerName, { startTime, endTime, duration });
        this.simpleLog(`Completed layer: ${layerName} in ${duration / 1000}s`);
      } catch (error: any) {
        this.simpleLog(
          `Failed layer: ${layerName} with error: ${error.message}`
        );
        throw error;
      }
    };

    // Concurrency Manager to handle execution of layers
    const concurrencyManager = async () => {
      const layerPromises: Array<Promise<void>> = [];

      for (const layerName of sortedLayers) {
        // Check if concurrency limit is not reached, then execute the next layer
        if (executingTasks.size < this.config.concurrency!) {
          const promise = executeLayer(layerName);
          executionPromises.set(layerName, promise);
          executingTasks.add(layerName); // Track the current executing task
          layerPromises.push(promise);
        } else {
          // Wait for one of the currently executing tasks to finish before starting a new one
          this.simpleLog(
            `Concurrency limit reached (${this.config
              .concurrency!}), waiting...`
          );
          await Promise.race(layerPromises);
        }
      }

      // Wait for all layers to finish execution
      await Promise.all(layerPromises);
    };

    // Start the concurrency manager to execute all layers in the order they were sorted
    await concurrencyManager();
  }

  private updateTimeline(
    layerName: string,
    event: "start" | "end",
    time: number
  ) {
    if (!this.timeline[layerName]) {
      this.timeline[layerName] = { start: null, end: null };
    }
    this.timeline[layerName][event] = time;
  }

  //   private async processJob(job: Job): Promise<any> {
  //     return tracer.startActiveSpan(`Process Job: ${job.name}`, async (span) => {
  //       const startTime = Date.now();
  //       const spinner = ora(`Processing: ${job.name}`).start();

  //       try {
  //         const layer = this.layers.get(job.name);
  //         if (!layer) {
  //           throw new Error(`Layer ${job.name} not found`);
  //         }

  //         const args = layer.args.map((arg) => this.context[arg]);
  //         const result = await layer.execute(...args);
  //         this.context[job.name] = result;

  //         const endTime = Date.now();
  //         this.metrics.set(job.name, {
  //           startTime,
  //           endTime,
  //           duration: endTime - startTime,
  //         });

  //         span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
  //         spinner.succeed(`Completed: ${job.name}`);
  //         return result;
  //       } catch (error) {
  //         span.setStatus({
  //           code: opentelemetry.SpanStatusCode.ERROR,
  //           message: error instanceof Error ? error.message : "Unknown error",
  //         });
  //         spinner.fail(`Failed: ${job.name}`);
  //         throw error;
  //       } finally {
  //         span.end();
  //       }
  //     });
  //   }

  private async processJob(job: Job): Promise<any> {
    const startTime = Date.now(); // Record start time
    const spinner = ora(`Processing: ${job.name}`).start();

    try {
      const layer = this.layers.get(job.name);
      if (!layer) {
        throw new Error(`Layer ${job.name} not found`);
      }

      const args = layer.args.map((arg) => this.context[arg]);
      const result = await layer.execute(...args);
      this.context[job.name] = result;

      const endTime = Date.now(); // Record end time
      this.metrics.set(job.name, {
        startTime,
        endTime,
        duration: endTime - startTime,
      });

      spinner.succeed(`Completed: ${job.name}`);
      return result;
    } catch (error) {
      spinner.fail(`Failed: ${job.name}`);
      throw error;
    }
  }

  async dummyApiCall(endpoint: string) {
    const response = await axios.get(endpoint);
    return response.data;
  }

  private logMetrics() {
    console.log(chalk.magenta("\n--- Execution Metrics ---"));
    const sortedMetrics = Array.from(this.metrics.entries()).sort(
      (a, b) => a[1].startTime - b[1].startTime
    );
    const totalDuration =
      sortedMetrics[sortedMetrics.length - 1][1].endTime -
      sortedMetrics[0][1].startTime;

    sortedMetrics.forEach(([name, metrics]) => {
      const startDiff = (metrics.startTime - this.executionStart) / 1000;
      const endDiff = (metrics.endTime - this.executionStart) / 1000;
      console.log(chalk.cyan(`${name}:`));
      console.log(`  Start: +${startDiff.toFixed(3)}s`);
      console.log(`  End: +${endDiff.toFixed(3)}s`);
      console.log(`  Duration: ${(metrics.duration / 1000).toFixed(3)}s`);
    });

    console.log(
      chalk.magenta(
        `\nTotal Execution Time: ${(totalDuration / 1000).toFixed(3)}s`
      )
    );

    // Generate and display the timeline
    console.log(chalk.yellow(generateTimeline(this.metrics, totalDuration)));
  }

  async save(filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
      tracer.startActiveSpan("Save Sequence", async (span) => {
        try {
          const data = JSON.stringify({
            layers: Array.from(this.layers.entries()),
            dependencies: Array.from(this.dependencies.entries()),
            config: this.config,
          });
          await fs.writeFile(path.resolve(filename), data);
          span.end();
          resolve();
        } catch (error) {
          span.setStatus({
            code: opentelemetry.SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Unknown error",
          });
          span.end();
          reject(error);
        }
      });
    });
  }

  static async load(filename: string): Promise<AdvancedSequenceBuilder> {
    return new Promise((resolve, reject) => {
      tracer.startActiveSpan("Load Sequence", async (span) => {
        try {
          const data = await fs.readFile(path.resolve(filename), "utf-8");
          const { layers, dependencies, config } = JSON.parse(data);
          const builder = new AdvancedSequenceBuilder(config);
          builder.layers = new Map(layers);
          builder.dependencies = new Map(
            dependencies.map(([key, value]: [string, string[]]) => [
              key,
              new Set(value),
            ])
          );
          span.end();
          resolve(builder);
        } catch (error) {
          span.setStatus({
            code: opentelemetry.SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Unknown error",
          });
          span.end();
          reject(error);
        }
      });
    });
  }
}

// Example usage with relevant async API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch user data by userId
const fetchUser = async (page: number, limit: number) => {
  console.log("START TIME:", Date.now());
  const response = await axios.get(
    `https://jsonplaceholder.typicode.com/users?_page=${page}&_limit=${limit}`
  );
  console.log("END TIME:", Date.now(), "\nResponse:", response.data);

  return response.data[8].id;
};

// Fetch user's todos by userId
const fetchTodosByUser = async (
  userId: string,
  page: number,
  limit: number
) => {
  console.log("START TIME:", Date.now(), "\nUserId:", userId);

  const response = await axios.get(
    `https://jsonplaceholder.typicode.com/todos/${userId}/?_page=${page}&_limit=${limit}`
  );
  console.log("END TIME:", Date.now(), "\nResponse:", response.data);

  return response.data.id;
};

// Fetch individual todo by todoId
const fetchTodoDetails = async (
  todoId: string,
  page: number,
  limit: number
) => {
  console.log("START TIME:", Date.now(), "\nTodoId:", todoId);
  const response = await axios.get(
    `https://jsonplaceholder.typicode.com/posts/${todoId}/comments?_page=${page}&_limit=${limit}`
  );
  console.log("END TIME:", Date.now(), "\nResponse:", response.data);
  return response.data;
};

// Fetch comments on a post (using the todo's id for simulation)
const fetchCommentsForTodo = async (
  todoId: string,
  page: number,
  limit: number
) => {
  console.log("START TIME:", Date.now(), "\nTodoId:", todoId);
  const response = await axios.get(
    `https://jsonplaceholder.typicode.com/posts/${todoId}/comments?_page=${page}&_limit=${limit}`
  );
  console.log("END TIME:", Date.now(), "\nResponse:", response.data);
  return response.data;
};

// Independent task that fetches posts
const fetchPosts = async (page: number, limit: number) => {
  console.log("START TIME:", Date.now());
  const response = await axios.get(
    `https://jsonplaceholder.typicode.com/posts?_page=${page}&_limit=${limit}`
  );
  console.log("END TIME:", Date.now(), "\nResponse:", response.data);
  return response.data;
};

// Independent task that fetches albums
const fetchAlbums = async (page: number, limit: number) => {
  console.log("START TIME:", Date.now());
  const response = await axios.get(
    `https://jsonplaceholder.typicode.com/albums?_page=${page}&_limit=${limit}`
  );
  console.log("END TIME:", Date.now(), "\nResponse:", response.data);
  return response.data;
};

const runSequence = async (useRedis: boolean) => {
  console.log(
    chalk.yellow.bold(
      `\n--- Starting Advanced Sequence Execution (${
        useRedis ? "Redis" : "In-Memory"
      }) ---\n`
    )
  );

  const sequence = new AdvancedSequenceBuilder({
    verbose: true,
    queueType: "FIFO",
    useRedis: useRedis,
    redisOptions: useRedis ? { host: "localhost", port: 6379 } : undefined,
    concurrency: 1, // Set concurrency limit
  });

  const page = 1;
  const limit = 10;

  // Initial context contains only page and limit
  sequence.context = {
    page,
    limit,
  };

  // Dependent layers that need dynamic context updates
  sequence.addLayer({
    name: "fetchUser",
    execute: async (page: number, limit: number) => {
      const userId = await fetchUser(page, limit);
      sequence.context.userId = userId; // Update the context with the userId
    },
    args: ["page", "limit"],
    description: "Fetch user information",
  });

  sequence.addLayer({
    name: "fetchTodosByUser",
    execute: async (userId: string, page: number, limit: number) => {
      const todoId = await fetchTodosByUser(userId, page, limit);
      sequence.context.todoId = todoId; // Update the context with the todoId
    },
    args: ["userId", "page", "limit"],
    dependsOn: ["fetchUser"], // Depends on userId from fetchUser
    description: "Fetch all todos for the user",
  });

  sequence.addLayer({
    name: "fetchTodoDetails",
    execute: async (todoId: string, page: number, limit: number) => {
      return await fetchTodoDetails(todoId, page, limit);
    },
    args: ["todoId", "page", "limit"],
    dependsOn: ["fetchTodosByUser"], // Depends on todoId from fetchTodosByUser
    description: "Fetch details of a specific todo",
  });

  sequence.addLayer({
    name: "fetchCommentsForTodo",
    execute: async (todoId: string, page: number, limit: number) => {
      return await fetchCommentsForTodo(todoId, page, limit);
    },
    args: ["todoId", "page", "limit"],
    dependsOn: ["fetchTodoDetails"], // Depends on the specific todo details
    description: "Fetch comments for the todo",
  });

  // Independent layers
  sequence.addLayer({
    name: "fetchPosts",
    execute: fetchPosts,
    args: ["page", "limit"],
    description: "Fetch all posts (independent task)",
  });

  sequence.addLayer({
    name: "fetchAlbums",
    execute: fetchAlbums,
    args: ["page", "limit"],
    description: "Fetch all albums (independent task)",
  });

  try {
    await sequence.build();
    console.log(chalk.green.bold("\n--- Sequence Execution Completed ---\n"));
    console.log(chalk.magenta("Final context:"));
    console.log(chalk.cyan(JSON.stringify(sequence.context, null, 2)));
  } catch (error) {
    console.error(chalk.red("Error building sequence:"), error);
  }
};

// Run sequences
(async () => {
  await runSequence(false); // In-memory queue
})();
