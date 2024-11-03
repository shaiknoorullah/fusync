import { Task } from "../interfaces/task.interface";

export class GraphNode {
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
