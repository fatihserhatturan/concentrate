import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { createPythonParser } from "../../languages/python/parser.js";
import { addPythonCommands } from "./commands.js";
import { createPythonContext } from "./context.js";
import { pythonFactsPlugin } from "./facts.js";
import { addPythonRoutes } from "./routes.js";

export { pythonEntrypointsContributor } from "./entrypoints.js";

// The Python parser with the framework layer's parse-time facts.
export const pythonFrameworkParser = createPythonParser([pythonFactsPlugin]);

// Routes (Flask, FastAPI, Starlette, Django, Django REST framework) and the
// entrypoints (Celery, click, typer, Django commands), finished once every
// file is parsed.
export const pythonRoutesContributor: ISemanticContributor = {
  async contribute(graph, rootPath) {
    const context = await createPythonContext(graph, rootPath);
    if (!context) return;
    const { handlerIds } = addPythonRoutes(context);
    addPythonCommands(context, handlerIds);
  },
};
