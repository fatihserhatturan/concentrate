import { createJsTsParser, type JsTsFrameworkPlugin } from "../../languages/js-ts/index.js";
import { createMarkupParser, type HtmlPagePlugin } from "../../languages/html/parser.js";
import { applyExpressKoaParseSemantics } from "./express-koa.js";
import { applyFastifyParseSemantics } from "./fastify.js";
import { applyNestJsParseSemantics } from "./nestjs.js";
import { applyBackendEntrypointParseSemantics } from "./backend-entrypoints.js";
import { applyEnvConfigParseSemantics } from "./env-config.js";
import { applyDataSchemaParseSemantics } from "./data-schemas.js";
import { applyDomAttributeSemantics, applyDomParseSemantics } from "./dom.js";
import { applyReactParseSemantics } from "./react.js";
import { applyReactRouterSemantics } from "./react-router.js";
import { applyHttpClientSemantics } from "./http-clients.js";
import { applyTrpcSemantics } from "./trpc.js";
import { applyServerFunctionSemantics } from "./server-functions.js";
import { applyTanStackRouterSemantics } from "./tanstack-router.js";
import { applyVueScriptSemantics, applyVueTemplateSemantics } from "./vue.js";

// Framework semantics for JS/TS files, in the order they run. Later plugins see
// the nodes earlier ones added (NestJS routes, for example, read decorators).
export const jsTsFrameworkPlugins: readonly JsTsFrameworkPlugin[] = [
  {
    name: "env-config",
    onFile: ({ fileNodeId, rootNode, parsed, state }) =>
      applyEnvConfigParseSemantics(
        fileNodeId,
        rootNode,
        parsed.nodes,
        parsed.relationships,
        state.functionAstPairs,
        state.variableDeclaratorAstNodes,
      ),
  },
  {
    name: "express-koa",
    onFile: ({ fileNodeId, rootNode, parsed, state }) =>
      applyExpressKoaParseSemantics(fileNodeId, rootNode, parsed.nodes, parsed.relationships, state.functionAstPairs),
  },
  {
    name: "fastify",
    // fastify.route({ handler, onRequest, ... }) and the route shorthand options.
    callbackPropertyNames: [
      "handler",
      "preHandler",
      "preValidation",
      "preParsing",
      "preSerialization",
      "onRequest",
      "onResponse",
      "onSend",
      "onTimeout",
      "onError",
    ],
    onFile: ({ fileNodeId, rootNode, parsed, state }) =>
      applyFastifyParseSemantics(fileNodeId, rootNode, parsed.nodes, parsed.relationships, state.functionAstPairs),
  },
  {
    name: "nestjs",
    onFile: ({ fileNodeId, parsed }) => applyNestJsParseSemantics(fileNodeId, parsed.nodes, parsed.relationships),
  },
  {
    name: "backend-entrypoints",
    onFile: ({ fileNodeId, rootNode, parsed }) =>
      applyBackendEntrypointParseSemantics(fileNodeId, rootNode, parsed.nodes, parsed.relationships),
  },
  {
    // TypeORM entities, Mongoose schemas and Drizzle tables.
    name: "data-schemas",
    onFile: ({ fileNodeId, rootNode, parsed }) =>
      applyDataSchemaParseSemantics(fileNodeId, rootNode, parsed.nodes, parsed.relationships),
  },
  {
    // addEventListener listeners and customElements.define.
    name: "dom",
    onFile: ({ fileNodeId, rootNode, parsed }) =>
      applyDomParseSemantics(fileNodeId, rootNode, parsed.nodes, parsed.relationships),
  },
  {
    // Function, class, memo and forwardRef components and the JSX they render.
    name: "react",
    onFile: applyReactParseSemantics,
  },
  {
    // The options, props and component registrations of a .vue file's script.
    name: "vue",
    onFile: applyVueScriptSemantics,
  },
  {
    // React Router <Route> trees and route objects.
    name: "react-router",
    onFile: applyReactRouterSemantics,
  },
  {
    // TanStack Router file and code routes.
    name: "tanstack-router",
    onFile: applyTanStackRouterSemantics,
  },
  {
    // "use server" functions (server actions).
    name: "server-functions",
    onFile: applyServerFunctionSemantics,
  },
  {
    // Outbound fetch, axios, ky and ofetch calls.
    name: "http-clients",
    onFile: applyHttpClientSemantics,
  },
  {
    // tRPC routers (procedures as routes) and client procedure calls.
    name: "trpc",
    onFile: applyTrpcSemantics,
  },
];

export const javascriptParser = createJsTsParser("javascript", jsTsFrameworkPlugins);
export const typescriptParser = createJsTsParser("typescript", jsTsFrameworkPlugins);
// Scripts of HTML pages and single-file components get the same framework
// semantics; the markup gets the DOM attribute semantics.
const markupPlugins: readonly HtmlPagePlugin[] = [
  {
    // on* event attributes.
    name: "dom-attributes",
    onPage: ({ fileNodeId, documentNode, parsed }) =>
      applyDomAttributeSemantics(fileNodeId, documentNode, parsed.nodes, parsed.relationships),
  },
  {
    // The component of a .vue file and the components its template renders.
    name: "vue-components",
    onPage: applyVueTemplateSemantics,
  },
];

export const htmlParser = createMarkupParser("html", jsTsFrameworkPlugins, markupPlugins);
export const vueParser = createMarkupParser("vue", jsTsFrameworkPlugins, markupPlugins);
export const svelteParser = createMarkupParser("svelte", jsTsFrameworkPlugins, markupPlugins);
export const astroParser = createMarkupParser("astro", jsTsFrameworkPlugins, markupPlugins);
