import chalk from "chalk";
import { Task } from "../../interfaces/task.interface";

// Timeline generation function
export const generateTimeline = (tasks: Task[], executionStart: number) => {
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