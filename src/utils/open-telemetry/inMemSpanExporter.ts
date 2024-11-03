import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

export class InMemorySpanExporter implements SpanExporter {
    public spans: ReadableSpan[] = [];

    export(spans: ReadableSpan[], resultCallback: (result: any) => void): void {
        this.spans.push(...spans);
        resultCallback({ code: 0 }); // 0 indicates success
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}