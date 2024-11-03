export interface LayerConfig {
    name: string;
    execute: (...args: any[]) => Promise<any> | any;
    dependsOn?: string[];
    retries?: number;
    retryDelay?: number;
    onError?: "continue" | "abort";
    priority?: number;
}
