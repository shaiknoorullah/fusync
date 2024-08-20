# Fusync.
A library for managing and executing complex sequences of asynchronous operations. Supports both in-memory and Redis-based queues, providing detailed execution metrics and visual timelines for tracking progress.

## Problem Statement
In modern application development, each method in a service class should adhere to the principle of single responsibility and avoid business-specific logic, often known as pure functions. Business logic should be composed by chaining these pure functions together, allowing them to execute actions in parallel or sequentially based on their dependencies. This approach helps in maintaining clean, modular, and maintainable code.

## Solution
The Async Operation Sequencer library addresses this challenge by providing a powerful tool for managing and executing complex sequences of asynchronous operations. It allows you to create chains of pure functions that can be executed either in parallel or sequentially, depending on their dependencies. This ensures that your service methods remain focused and your business logic is cleanly abstracted.

## Features

- **Flexible Queue Options**: Use in-memory or Redis-based queues for task management.
- **Detailed Execution Metrics**: Track the start, end, and duration of each task.
- **Visual Timeline**: Generate and display a progress timeline of the execution sequence.
- **Error Handling**: Graceful error handling and logging with customizable verbosity.
- **OpenTelemetry Integration**: Built-in tracing support for observability.

## Installation

To install the library, use npm or yarn:

```bash
npm install fusync
# or
yarn add fusync
```
## Usage
### Example
Here is an example of how to use the library:

```typescript
import { AdvancedSequenceBuilder } from 'advanced-sequence-builder';

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
## Configuration
The library can be configured using the `SequenceConfig` interface:

- `verbose`: Enable detailed logging.
- `queueType`: Set to 'FIFO' or 'LIFO'.
- `useRedis`: Boolean to switch between Redis and in-memory queue.
- `redisOptions`: Configuration options for Redis.
- `concurrency`: Number of concurrent jobs.

## API
`AdvancedSequenceBuilder`
`addLayer(config: LayerConfig)`: Add a layer to the sequence.
`removeLayer(name: string)`: Remove a layer from the sequence.
`build()`: Build and execute the sequence.
`save(filename: string)`: Save the current sequence to a file.
`static load(filename: string)`: Load a sequence from a file.

## Contributing
Contributions are welcome! Please fork the repository and submit a pull request.

## License
This project is licensed under the MIT License - see the LICENSE file for details.

## Contact
For questions or issues, please open an issue on GitHub or contact the maintainer at noorullah@websleak.com.
