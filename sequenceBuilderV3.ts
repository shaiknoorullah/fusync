import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { v4 as uuidv4 } from 'uuid';
import * as opentelemetry from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { Queue, Worker, Job, RedisOptions } from 'bullmq';
import { terminal } from 'terminal-kit';

// Set up OpenTelemetry
const provider = new NodeTracerProvider();
const exporter = new ConsoleSpanExporter();
const processor = new SimpleSpanProcessor(exporter);
provider.addSpanProcessor(processor);
provider.register();

const tracer = opentelemetry.trace.getTracer('advanced-sequence-builder');

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
    queueType: 'FIFO' | 'LIFO';
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

    constructor(private queueType: 'FIFO' | 'LIFO') {
        super();
    }

    async add(name: string, data: any, opts?: any): Promise<Job> {
        const job = { id: opts?.jobId || uuidv4(), name, data };
        if (this.queueType === 'FIFO') {
            this.jobs.push(job);
        } else {
            this.jobs.unshift(job);
        }
        this.emit('added', job);
        return job as Job;
    }

    async process(processor: (job: Job) => Promise<any>): Promise<void> {
        while (this.jobs.length > 0) {
            const job = this.jobs.shift() as Job;
            try {
                await processor(job);
                this.emit('completed', job);
            } catch (error) {
                this.emit('failed', job, error);
            }
        }
    }

    async getJob(jobId: string): Promise<Job | null> {
        return this.jobs.find(job => job.id === jobId) || null;
    }

    async waitUntilReady(): Promise<void> {
        // No-op for in-memory queue
    }
}

function generateTimeline(metrics: Map<string, ExecutionMetrics>, totalDuration: number): string {
    const terminalWidth = terminal.width || 80;
    const padding = 2;
    const availableWidth = terminalWidth - (padding * 2);

    // Calculate the width of the first column
    const maxNameLength = Math.max(...Array.from(metrics.keys()).map(name => name.length));
    const nameColumnWidth = maxNameLength + 5;

    // Calculate widths for progress bar and time columns
    const remainingWidth = availableWidth - nameColumnWidth - 3; // 3 for border characters
    const progressBarWidth = Math.floor(remainingWidth * 0.7);
    const timeColumnWidth = remainingWidth - progressBarWidth;

    let output = '\n' + '─'.repeat(terminalWidth) + '\n';
    output += `${' '.repeat(padding)}${'Layer Name'.padEnd(nameColumnWidth)}│${'Progress'.padEnd(progressBarWidth)}│${'Execution Time'.padEnd(timeColumnWidth)}${' '.repeat(padding)}\n`;
    output += '─'.repeat(terminalWidth) + '\n';

    const sortedMetrics = Array.from(metrics.entries()).sort((a, b) => a[1].startTime - b[1].startTime);
    const startTime = sortedMetrics[0][1].startTime;

    sortedMetrics.forEach(([name, metric]) => {
        const startOffset = Math.floor((metric.startTime - startTime) / totalDuration * progressBarWidth);
        const duration = Math.max(1, Math.floor(metric.duration / totalDuration * progressBarWidth));

        const nameColumn = name.padEnd(nameColumnWidth);
        const progressBar = ' '.repeat(startOffset) + '█'.repeat(duration).padEnd(progressBarWidth - startOffset);

        const startStr = `+${((metric.startTime - startTime) / 1000).toFixed(3)}s`;
        const endStr = `+${((metric.endTime - startTime) / 1000).toFixed(3)}s`;
        const durationStr = `(${(metric.duration / 1000).toFixed(3)}s)`;
        const timeColumn = `${startStr} to ${endStr} ${durationStr}`.padEnd(timeColumnWidth);

        output += `${' '.repeat(padding)}${nameColumn}│${progressBar}│${timeColumn}${' '.repeat(padding)}\n`;
    });

    output += '─'.repeat(terminalWidth) + '\n';

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
    private timeline: Record<string, { start: number | null, end: number | null }>;

    constructor(private config: SequenceConfig) {
        this.timeline = {}
        if (config.useRedis && config.redisOptions) {
            this.queue = new Queue('sequence-tasks', {
                connection: config.redisOptions
            });
            this.worker = new Worker('sequence-tasks', this.processJob.bind(this), {
                connection: config.redisOptions,
                concurrency: config.concurrency || 5
            });
            this.setupBullMQEvents();
        } else {
            this.queue = new InMemoryQueue(config.queueType);
            this.setupInMemoryQueueEvents();
        }
    }

    private setupBullMQEvents() {
        if (this.worker) {
            this.worker.on('completed', (job) => {
                this.log('success', `Job completed: ${job.name}`);
            });

            this.worker.on('failed', (job, error) => {
                if (job) {
                    this.log('error', `Job failed: ${job.name}`, error);
                } else {
                    this.log('error', 'Job failed', error);
                }
            });
        }
    }


    private setupInMemoryQueueEvents() {
        (this.queue as InMemoryQueue).on('added', (job) => {
            this.log('info', `Job added to queue: ${job.name} [${job.id}]`);
        });

        (this.queue as InMemoryQueue).on('completed', (job) => {
            this.log('success', `Job completed: ${job.name} [${job.id}]`);
        });

        (this.queue as InMemoryQueue).on('failed', (job, error) => {
            this.log('error', `Job failed: ${job.name} [${job.id}]`, error);
        });
    }

    private log(type: 'info' | 'success' | 'warning' | 'error', message: string, data?: any) {
        if (!this.config.verbose) return;

        const timestamp = new Date().toISOString();
        const timeSinceStart = this.executionStart ? `+${((Date.now() - this.executionStart) / 1000).toFixed(3)}s` : '';
        let coloredMessage;
        switch (type) {
            case 'info':
                coloredMessage = chalk.blue(message);
                break;
            case 'success':
                coloredMessage = chalk.green(message);
                break;
            case 'warning':
                coloredMessage = chalk.yellow(message);
                break;
            case 'error':
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
        this.log('info', `Starting sequence execution (${this.config.useRedis ? 'Redis' : 'In-Memory'} mode)`);

        return new Promise(async (resolve, reject) => {
            await tracer.startActiveSpan('Build Sequence', async (span) => {
                try {
                    const sortedLayers = this.topologicalSort();
                    await this.executeLayersInOrder(sortedLayers);
                    span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
                    this.logMetrics();
                    resolve();
                } catch (error) {
                    span.setStatus({
                        code: opentelemetry.SpanStatusCode.ERROR,
                        message: error instanceof Error ? error.message : 'Unknown error',
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
        return tracer.startActiveSpan('Topological Sort', (span) => {
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
                sortedLayers: sortedLayers.join(',')
            });
            span.end();
            this.log('info', `Layers sorted: ${sortedLayers.join(' -> ')}`);
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

    private async executeLayersInOrder(sortedLayers: string[]): Promise<void> {
        const executionPromises = new Map<string, Promise<void>>();

        const executeLayer = async (layerName: string) => {
            const startTime = Date.now(); // Capture start time
            this.log('info', `Starting execution of layer: ${layerName}`);
            this.updateTimeline(layerName, 'start', startTime);

            const dependencies = this.dependencies.get(layerName) || new Set();
            await Promise.all(Array.from(dependencies).map(dep => executionPromises.get(dep)));

            try {
                if (this.config.useRedis) {
                    await this.queue.add(layerName, { layerName, args: this.layers.get(layerName)?.args }, {
                        jobId: layerName,
                        attempts: this.layers.get(layerName)?.retries || 3,
                        backoff: {
                            type: 'exponential',
                            delay: 1000,
                        },
                    });
                } else {
                    await this.processJob({ name: layerName, data: { layerName } } as Job);
                }
            } finally {
                const endTime = Date.now(); // Capture end time
                this.updateTimeline(layerName, 'end', endTime);
                this.log('info', `Completed execution of layer: ${layerName}`);
            }
        };

        const layerPromises = sortedLayers.map(layerName => {
            const promise = executeLayer(layerName);
            executionPromises.set(layerName, promise);
            return promise;
        });

        await Promise.all(layerPromises);

        if (this.config.useRedis) {
            await this.queue.waitUntilReady();
            await new Promise<void>(resolve => {
                this.worker!.on('drained', resolve);
            });
        }
    }

    private updateTimeline(layerName: string, event: 'start' | 'end', time: number) {
        if (!this.timeline[layerName]) {
            this.timeline[layerName] = { start: null, end: null };
        }
        this.timeline[layerName][event] = time;
    }


    private async processJob(job: Job): Promise<any> {
        return tracer.startActiveSpan(`Process Job: ${job.name}`, async (span) => {
            const startTime = Date.now();
            const spinner = ora(`Processing: ${job.name}`).start();

            try {
                const layer = this.layers.get(job.name);
                if (!layer) {
                    throw new Error(`Layer ${job.name} not found`);
                }

                const args = layer.args.map(arg => this.context[arg]);
                const result = await layer.execute(...args);
                this.context[job.name] = result;

                const endTime = Date.now();
                this.metrics.set(job.name, {
                    startTime,
                    endTime,
                    duration: endTime - startTime
                });

                span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
                spinner.succeed(`Completed: ${job.name}`);
                return result;
            } catch (error) {
                span.setStatus({
                    code: opentelemetry.SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : 'Unknown error'
                });
                spinner.fail(`Failed: ${job.name}`);
                throw error;
            } finally {
                span.end();
            }
        });
    }



    private logMetrics() {
        console.log(chalk.magenta('\n--- Execution Metrics ---'));
        const sortedMetrics = Array.from(this.metrics.entries()).sort((a, b) => a[1].startTime - b[1].startTime);
        const totalDuration = sortedMetrics[sortedMetrics.length - 1][1].endTime - sortedMetrics[0][1].startTime;

        sortedMetrics.forEach(([name, metrics]) => {
            const startDiff = (metrics.startTime - this.executionStart) / 1000;
            const endDiff = (metrics.endTime - this.executionStart) / 1000;
            console.log(chalk.cyan(`${name}:`));
            console.log(`  Start: +${startDiff.toFixed(3)}s`);
            console.log(`  End: +${endDiff.toFixed(3)}s`);
            console.log(`  Duration: ${(metrics.duration / 1000).toFixed(3)}s`);
        });

        console.log(chalk.magenta(`\nTotal Execution Time: ${(totalDuration / 1000).toFixed(3)}s`));

        // Generate and display the timeline
        console.log(chalk.yellow(generateTimeline(this.metrics, totalDuration)));
    }



    async save(filename: string): Promise<void> {
        return new Promise((resolve, reject) => {
            tracer.startActiveSpan('Save Sequence', async (span) => {
                try {
                    const data = JSON.stringify({
                        layers: Array.from(this.layers.entries()),
                        dependencies: Array.from(this.dependencies.entries()),
                        config: this.config
                    });
                    await fs.writeFile(path.resolve(filename), data);
                    span.end();
                    resolve();
                } catch (error) {
                    span.setStatus({
                        code: opentelemetry.SpanStatusCode.ERROR,
                        message: error instanceof Error ? error.message : 'Unknown error'
                    });
                    span.end();
                    reject(error);
                }
            });
        });
    }

    static async load(filename: string): Promise<AdvancedSequenceBuilder> {
        return new Promise((resolve, reject) => {
            tracer.startActiveSpan('Load Sequence', async (span) => {
                try {
                    const data = await fs.readFile(path.resolve(filename), 'utf-8');
                    const { layers, dependencies, config } = JSON.parse(data);
                    const builder = new AdvancedSequenceBuilder(config);
                    builder.layers = new Map(layers);
                    builder.dependencies = new Map(dependencies.map(([key, value]: [string, string[]]) => [key, new Set(value)]));
                    span.end();
                    resolve(builder);
                } catch (error) {
                    span.setStatus({
                        code: opentelemetry.SpanStatusCode.ERROR,
                        message: error instanceof Error ? error.message : 'Unknown error'
                    });
                    span.end();
                    reject(error);
                }
            });
        });
    }
}

// Example usage
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const checkInventory = async (productId: string, quantity: number): Promise<{ available: boolean; stock: number }> => {
    return tracer.startActiveSpan('Check Inventory', async (span) => {
        span.setAttributes({ productId, quantity });
        console.log(chalk.blue(`Checking inventory for product ${productId}, quantity ${quantity}`));
        await delay(1000);
        const result = { available: true, stock: 100 };
        span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
        span.end();
        return result;
    });
};

const reserveInventory = async (productId: string, quantity: number): Promise<{ reserved: boolean }> => {
    return tracer.startActiveSpan('Reserve Inventory', async (span) => {
        span.setAttributes({ productId, quantity });
        console.log(chalk.blue(`Reserving inventory for product ${productId}, quantity ${quantity}`));
        await delay(800);
        const result = { reserved: true };
        span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
        span.end();
        return result;
    });
};

const validateCustomer = async (customerId: string): Promise<{ valid: boolean; creditScore: number }> => {
    return tracer.startActiveSpan('Validate Customer', async (span) => {
        span.setAttributes({ customerId });
        console.log(chalk.blue(`Validating customer ${customerId}`));
        await delay(1200);
        const result = { valid: true, creditScore: 750 };
        span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
        span.end();
        return result;
    });
};

const createOrder = async (customerId: string, productId: string, quantity: number): Promise<{ orderId: string; status: string }> => {
    return tracer.startActiveSpan('Create Order', async (span) => {
        span.setAttributes({ customerId, productId, quantity });
        console.log(chalk.blue(`Creating order for customer ${customerId}, product ${productId}, quantity ${quantity}`));
        await delay(1500);
        const result = { orderId: 'ORDER123', status: 'created' };
        span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
        span.end();
        return result;
    });
};

const processPayment = async (orderId: string, amount: number): Promise<{ paymentId: string; status: string }> => {
    return tracer.startActiveSpan('Process Payment', async (span) => {
        span.setAttributes({ orderId, amount });
        console.log(chalk.blue(`Processing payment for order ${orderId}, amount ${amount}`));
        await delay(2000);
        const result = { paymentId: 'PAYMENT123', status: 'success' };
        span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
        span.end();
        return result;
    });
};

const runSequence = async (useRedis: boolean = false) => {
    console.log(chalk.yellow.bold(`\n--- Starting Advanced Sequence Execution (${useRedis ? 'Redis' : 'In-Memory'}) ---\n`));

    const sequence = new AdvancedSequenceBuilder({
        verbose: true,
        queueType: 'FIFO',
        useRedis: useRedis,
        redisOptions: useRedis ? { host: 'localhost', port: 6379 } : undefined,
        concurrency: 1
    });

    sequence.context = {
        productId: 'PROD001',
        quantity: 5,
        customerId: 'CUST001',
        amount: 100
    };

    sequence.addLayer({
        name: 'checkInventory',
        execute: checkInventory,
        args: ['productId', 'quantity'],
        description: 'Check product inventory'
    });

    sequence.addLayer({
        name: 'validateCustomer',
        execute: validateCustomer,
        args: ['customerId'],
        description: 'Validate customer'
    });

    sequence.addLayer({
        name: 'reserveInventory',
        execute: reserveInventory,
        args: ['productId', 'quantity'],
        description: 'Reserve inventory',
        dependsOn: ['checkInventory']
    });

    sequence.addLayer({
        name: 'createOrder',
        execute: createOrder,
        args: ['customerId', 'productId', 'quantity'],
        description: 'Create a new order',
        dependsOn: ['reserveInventory', 'validateCustomer']
    });

    sequence.addLayer({
        name: 'processPayment',
        execute: processPayment,
        args: ['orderId', 'amount'],
        description: 'Process payment for the order',
        dependsOn: ['createOrder']
    });

    try {
        await sequence.build();
        console.log(chalk.green.bold('\n--- Sequence Execution Completed ---\n'));
        console.log(chalk.magenta('Final context:'));
        console.log(chalk.cyan(JSON.stringify(sequence.context, null, 2)));
    } catch (error) {
        console.error(chalk.red('Error building sequence:'), error);
    }
};

// Run sequences
(async () => {
    await runSequence(false); // In-memory queue
    // await runSequence(true);  // Redis-based queue
})();