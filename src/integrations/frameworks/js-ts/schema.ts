import type { GraphSchemaExtension } from "../../../core/graph/schema.js";

// JavaScript/TypeScript framework properties: store and Redux access, HTTP client calls, form actions, tRPC routers, injected fields.
export const jsTsGraphSchema: GraphSchemaExtension = {
  id: "js-ts-frameworks",
  nodeProperties: [
    { label: "Function", after: "returnType", properties: { storeRefs: "STRING", storeSelects: "STRING", formAction: "STRING" } },
    { label: "Call", after: "httpClient", properties: { httpReceiver: "STRING" } },
    { label: "Call", after: "httpUrl", properties: { httpUrlAlternatives: "STRING", storeAccess: "STRING", reduxAccess: "STRING" } },
    { label: "Field", after: "line", properties: { isInjected: "BOOLEAN" } },
    { label: "Variable", after: "httpClient", properties: { httpBaseUrl: "STRING", trpcRouter: "BOOLEAN", trpcMounts: "STRING" } },
  ],
};
