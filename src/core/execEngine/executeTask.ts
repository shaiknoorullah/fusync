import { Task } from "../../interfaces/task.interface";
import * as opentelemetry from '@opentelemetry/api'
import { log } from "../../utils/log-utils/logger";
import { delay } from "../../utils/delay";

export async function executeTaskWithRetries(
    task: Task,
    args: any[],
    executionStart: number,
    tracer: opentelemetry.Tracer
  ): Promise<any> {
    return tracer.startActiveSpan(`Task ${task.id}`, async (span) => {
      let attempts = 0;
      const maxAttempts = task.retryCount ?? 0;
      const retryDelay = task.retryDelay ?? 0;
  
      while (attempts <= maxAttempts) {
        try {
          log("info", `Starting Task ${task.id}`, args, executionStart);
          const startTime = Date.now();
  
          const result = await Promise.resolve(task.action(...args));
  
          const endTime = Date.now();
          task.metrics = {
            startTime,
            endTime,
            duration: endTime - startTime,
          };
          task.status = "success";
  
          log("success", `Completed Task ${task.id}`, result, executionStart);
  
          span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
          return result;
        } catch (error: any) {
          attempts++;
          span.addEvent(`Attempt ${attempts} failed: ${error.message}`);
          if (attempts > maxAttempts) {
            span.setStatus({
              code: opentelemetry.SpanStatusCode.ERROR,
              message: error.message,
            });
            log(
              "error",
              `Task ${task.id} failed after retries`,
              null,
              executionStart
            );
            task.status = "failed";
            throw error;
          }
          log(
            "warning",
            `Task ${task.id} failed on attempt ${attempts}: ${error.message}`,
            null,
            executionStart
          );
          log(
            "info",
            `Retrying Task ${task.id} in ${retryDelay}ms`,
            null,
            executionStart
          );
          await delay(retryDelay);
        } finally {
          span.end();
        }
      }
    });
  }