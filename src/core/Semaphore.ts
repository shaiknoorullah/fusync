// Semaphore class for concurrency control
export class Semaphore {
    private tasks: (() => void)[] = [];
    private counter: number;
  
    constructor(private maxConcurrency: number) {
      this.counter = this.maxConcurrency;
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
  