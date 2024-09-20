# Fusync

A powerful library for managing and executing complex sequences of asynchronous operations. Fusync supports both in-memory and Redis-based queues, providing detailed execution metrics, visual timelines, and OpenTelemetry integration for tracking progress and performance.

## Table of Contents

1. [Motivation](#motivation)
2. [Features](#features)
3. [Installation](#installation)
4. [Usage](#usage)
   - [Basic Example](#basic-example)
   - [Advanced Example](#advanced-example)
5. [Configuration](#configuration)
   - [SequenceConfig Options](#sequenceconfig-options)
6. [API Reference](#api-reference)
   - [AdvancedSequenceBuilder](#advancedsequencebuilder)
   - [LayerConfig](#layerconfig)
7. [Execution Visualization](#execution-visualization)
   - [Timeline Generation](#timeline-generation)
   - [Graph Visualization](#graph-visualization)
8. [Performance Metrics](#performance-metrics)
9. [Error Handling](#error-handling)
10. [OpenTelemetry Integration](#opentelemetry-integration)
11. [Redis Integration](#redis-integration)
12. [Best Practices](#best-practices)
13. [Contributing](#contributing)
14. [License](#license)
15. [Contact](#contact)

## Problem Statement

In modern application development, each method in a service class should adhere to the principle of single responsibility and avoid business-specific logic, often known as pure functions. Business logic should be composed by chaining these pure functions together, allowing them to execute actions in parallel or sequentially based on their dependencies. This approach helps in maintaining clean, modular, and maintainable code.

## Solution

Fusync addresses this challenge by providing a powerful tool for managing and executing complex sequences of asynchronous operations. It allows you to create chains of pure functions that can be executed either in parallel or sequentially, depending on their dependencies. This ensures that your service methods remain focused and your business logic is cleanly abstracted.

## Features

- **Flexible Queue Options**: Use in-memory or Redis-based queues for task management.
- **Detailed Execution Metrics**: Track the start, end, and duration of each task.
- **Visual Timeline**: Generate and display a progress timeline of the execution sequence.
- **Graph Visualization**: Visualize the dependency graph of your tasks.
- **Error Handling**: Graceful error handling and logging with customizable verbosity.
- **OpenTelemetry Integration**: Built-in tracing support for observability.
- **Concurrency Control**: Manage the number of tasks running simultaneously.
- **Priority Execution**: Assign priorities to tasks for optimized execution order.
- **Retry Mechanism**: Configurable retry attempts for failed tasks.
- **Dependency Management**: Define and manage task dependencies effortlessly.

## Installation

To install Fusync, use pnpm or npm or yarn:

```bash
pnpm install fusync
# or
npm install fusync
# or
yarn add fusync
```

## Usage

### Basic Example

Here's a simple example of how to use Fusync:

```typescript
import { AdvancedSequenceBuilder } from 'fusync';

// Define your asynchronous operations
const checkInventory = async (productId: string, quantity: number) => { /*...*/ };
const reserveInventory = async (productId: string, quantity: number) => { /*...*/ };
const validateCustomer = async (customerId: string) => { /*...*/ };
const createOrder = async (customerId: string, productId: string, quantity: number) => { /*...*/ };
const processPayment = async (orderId: string, amount: number) => { /*...*/ };

// Create a new sequence builder instance
const sequence = new AdvancedSequenceBuilder({
    verbose: true,
    queueType: 'FIFO',
    useRedis: false,
    concurrency: 3
});

// Add layers to the sequence
sequence.addLayer({
    name: 'checkInventory',
    execute: checkInventory,
    args: ['productId', 'quantity'],
    description: 'Check product inventory'
});

// Add more layers...

// Build and execute the sequence
await sequence.build();
```

### Advanced Example

For a more complex scenario with dependencies and priorities:

```typescript
// ... (import and define operations)

const sequence = new AdvancedSequenceBuilder({
    verbose: true,
    queueType: 'FIFO',
    useRedis: true,
    concurrency: 5
});

sequence
    .addLayer({
        name: 'checkInventory',
        execute: checkInventory,
        args: ['productId', 'quantity'],
        priority: 1
    })
    .addLayer({
        name: 'validateCustomer',
        execute: validateCustomer,
        args: ['customerId'],
        priority: 1
    })
    .addLayer({
        name: 'reserveInventory',
        execute: reserveInventory,
        args: ['productId', 'quantity'],
        dependsOn: ['checkInventory'],
        priority: 2
    })
    .addLayer({
        name: 'createOrder',
        execute: createOrder,
        args: ['customerId', 'productId', 'quantity'],
        dependsOn: ['validateCustomer', 'reserveInventory'],
        priority: 3
    })
    .addLayer({
        name: 'processPayment',
        execute: processPayment,
        args: ['orderId', 'amount'],
        dependsOn: ['createOrder'],
        priority: 4
    });

await sequence.build();
```

## Configuration

Fusync can be configured using the `SequenceConfig` interface:

### SequenceConfig Options

- `verbose`: (boolean) Enable detailed logging.
- `queueType`: ('FIFO' | 'LIFO') Set the queue type.
- `useRedis`: (boolean) Switch between Redis and in-memory queue.
- `redisOptions`: (RedisOptions) Configuration options for Redis.
- `concurrency`: (number) Number of concurrent jobs.
- `maxRetries`: (number) Maximum number of retry attempts for failed tasks.
- `retryDelay`: (number) Delay (in ms) between retry attempts.

## API Reference

### AdvancedSequenceBuilder

- `constructor(config: SequenceConfig)`
- `addLayer(config: LayerConfig): this`
- `removeLayer(name: string): this`
- `build(): Promise<void>`
- `save(filename: string): Promise<void>`
- `static load(filename: string): AdvancedSequenceBuilder`

### LayerConfig

- `name`: (string) Unique name for the layer.
- `execute`: (Function) The async function to execute.
- `args`: (string[]) Names of arguments to pass to the execute function.
- `dependsOn`: (string[]) Names of layers this layer depends on.
- `priority`: (number) Execution priority (higher numbers = higher priority).
- `retries`: (number) Number of retry attempts for this specific layer.
- `retryDelay`: (number) Delay between retries for this layer.
- `onError`: ('continue' | 'abort') Action to take on error.

## Execution Visualization

### Timeline Generation

Fusync provides a visual timeline of task execution, helping you understand the sequence and duration of each task:

```
--- Execution Timeline ---

Task Name     │Progress                        │Execution Time
─────────────────────────────────────────────────────────────────
checkInventory│███████                         │+0.100s to +0.300s (0.200s)
validateCustom│ ████████                       │+0.150s to +0.400s (0.250s)
reserveInvento│        ██████                  │+0.350s to +0.550s (0.200s)
createOrder   │              ████████          │+0.600s to +0.850s (0.250s)
processPayment│                      ██████████│+0.900s to +1.200s (0.300s)
```

### Graph Visualization

Fusync can generate a visual representation of your task dependency graph:

```
       ┌─────────────┐     ┌─────────────┐
       │checkInventor│     │validateCusto│
       └─────┬───────┘     └──────┬──────┘
             │                    │
             │                    │
       ┌─────▼───────┐            │
       │reserveInvent│            │
       └─────┬───────┘            │
             │                    │
             │    ┌───────────────▼┐
             └────►   createOrder  │
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │ processPayment │
                  └────────────────┘
```

## Performance Metrics

Fusync provides detailed performance metrics for your task execution:

```
--- Sequence Execution Performance Metrics ---

Total Execution Time: 1.200 seconds
Total Tasks: 5
Successful Tasks: 5
Failed Tasks: 0
Success Rate: 100.00%
Average Task Duration: 0.240 seconds
Maximum Task Duration: 0.300 seconds
Minimum Task Duration: 0.200 seconds
```

## Error Handling

Fusync provides robust error handling capabilities:

- Configurable retry mechanisms for failed tasks.
- Options to continue or abort the sequence on task failure.
- Detailed error logging and reporting.

## OpenTelemetry Integration

Fusync integrates with OpenTelemetry for advanced tracing and observability:

- Automatic span creation for each task.
- Detailed tracing information including task duration and dependencies.
- Easy integration with your existing OpenTelemetry setup.

## Redis Integration

For distributed systems, Fusync offers Redis-based queue management:

- Scalable task queue for distributed environments.
- Persistence of task state across application restarts.
- Configurable Redis connection options.

## Best Practices

1. **Task Granularity**: Define tasks at an appropriate level of granularity to balance reusability and complexity.
2. **Error Handling**: Always specify how errors should be handled for each task.
3. **Timeouts**: Consider adding timeouts to long-running tasks to prevent bottlenecks.
4. **Monitoring**: Utilize the built-in metrics and OpenTelemetry integration for comprehensive monitoring.
5. **Testing**: Create unit tests for individual tasks and integration tests for sequences.

## Contributing

Contributions to Fusync are welcome! Please follow these steps:

1. Fork the repository and checke the `TODO.md`.
2. Create a new branch for your feature or bugfix.
3. Write tests for your changes.
4. Implement your changes.
5. Run the test suite to ensure all tests pass.
6. Submit a pull request with a clear description of your changes.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contact

For questions, issues, or feature requests, please open an issue on GitHub or contact the maintainer at noorullah@websleak.com.