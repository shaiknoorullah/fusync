import { ExecutionMetrics } from "./executionMetrics.interface";

export interface Task {
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