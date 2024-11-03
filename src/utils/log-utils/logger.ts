import chalk from "chalk";

// Logging function
export const log = (
    type: "info" | "success" | "warning" | "error",
    message: string,
    data?: any,
    executionStart?: number
) => {
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