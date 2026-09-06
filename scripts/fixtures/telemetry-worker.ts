import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { StudioTelemetry } from "../../packages/observability/src/index";
const exporter=new InMemorySpanExporter();
const telemetry=new StudioTelemetry({service:"worker",spanExporter:exporter});
await telemetry.run("job.process",{"hv.stage":"animatic"},async()=>{
  await telemetry.run("provider.generate",{"hv.provider":"mock"},async()=>{await Bun.sleep(1);});
},process.argv[2]);
await telemetry.flush();
console.log(JSON.stringify(exporter.getFinishedSpans().map(span=>({name:span.name,traceId:span.spanContext().traceId,spanId:span.spanContext().spanId,parent:span.parentSpanContext?.spanId}))));
await telemetry.shutdown();
