// Copy to <checkout>/scratch/demo.mjs and run with Node 22:
// node --import tsx scratch/demo.mjs
// Requires a loopback Jaeger collector on 4318 and UI/API on 16686.
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { workerTracingOptions } from "../apps/worker/src/worker-tracing.ts";
import { TemporalCodexAppServerTurnStarter } from "../apps/api/src/turns.ts";
import { createHttpObservability } from "../apps/api/src/observability.ts";
import { requestTraceContexts, traceContextForRawRequest } from "../apps/api/src/trace-context.ts";

const env = await TestWorkflowEnvironment.createTimeSkipping();
const apiExporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "space-api" });
const workerExporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "space-worker" });
const taskQueue = `demo-${randomUUID()}`;
const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
  workflowsPath: fileURLToPath(new URL("../apps/worker/src/workflows.ts", import.meta.url)),
  ...workerTracingOptions(workerExporter), activities: {
    runCodexAppServerTurn: async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { status: "COMPLETED", message: "Synthetic trace demonstration" };
    }
  } });
const starter = new TemporalCodexAppServerTurnStarter({ address: "unused", namespace: "default", taskQueue,
  clientFactory: async () => ({ client: env.client, close: async () => undefined }) });
const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiExporter });
const app = Fastify({ genReqId: () => "req:demo00000001" });
let context;
app.addHook("onRequest", async request => {
  observability.onRequest(request);
  context = traceContextForRawRequest(request.raw);
  requestTraceContexts.remember(request.id, context);
});
app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
app.post("/demo", async request => {
  const started = await starter.start({ roomId: "room:demo", paneId: "pane:demo", prompt: "Synthetic demo",
    artifactIds: [], permissionMode: null, collaborationMode: "default", traceId: request.id });
  return env.client.workflow.getHandle(started.workflowId).result();
});

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  await worker.runUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/demo`, { method: "POST" });
    if (!response.ok) throw new Error(`Demo HTTP request failed: ${response.status}`);
    const result = await response.json();
    if (result.status !== "COMPLETED") throw new Error("Unexpected workflow result");
  });
  await Promise.all([apiExporter.flush(), workerExporter.flush()]);
  const url = `http://127.0.0.1:16686/api/traces/${context.w3cTraceId}`;
  let data;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      data = await response.json();
      if (data.data?.[0]?.spans?.length === 3) break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const spans = data?.data?.[0]?.spans ?? [];
  if (spans.length !== 3) throw new Error(`Expected 3 Jaeger spans, got ${spans.length}`);
  const api = spans.find(span => span.operationName === "POST /demo");
  const workflow = spans.find(span => span.operationName === "temporal.workflow");
  const activity = spans.find(span => span.operationName === "temporal.activity");
  if (workflow?.references?.[0]?.spanID !== api?.spanID || activity?.references?.[0]?.spanID !== workflow?.spanID) {
    throw new Error("Jaeger did not record the expected API → workflow → activity tree");
  }
  await writeFile("/tmp/spaceapp-61-jaeger.json", JSON.stringify(data, null, 2));
  await writeFile("/tmp/spaceapp-61-demo.json", JSON.stringify({ traceId: context.w3cTraceId,
    spanIds: { api: api.spanID, workflow: workflow.spanID, activity: activity.spanID },
    api: apiExporter.stats(), worker: workerExporter.stats(),
    ui: `http://127.0.0.1:16686/trace/${context.w3cTraceId}`, syntheticActivity: true }, null, 2));
  console.log(`Jaeger verified API → workflow → activity: ${context.w3cTraceId}`);
} finally {
  await app.close();
  observability.close();
  await Promise.all([apiExporter.close(), workerExporter.close()]);
  await env.teardown();
}
