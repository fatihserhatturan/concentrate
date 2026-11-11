import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { createPythonParser } from "../../languages/python/parser.js";
import { addPythonCommands } from "./commands.js";
import { createPythonContext } from "./context.js";
import { pythonFactsPlugin } from "./facts.js";
import { addPythonRoutes } from "./routes.js";
import { addPythonDataAccess } from "./data-access.js";
import { pythonDataPlugin } from "./data-facts.js";
import { addPythonDi, pythonDiPlugin } from "./di.js";
import { addPythonEnv, pythonEnvPlugin } from "./env-config.js";
import { addPythonHttpEnv, pythonHttpPlugin } from "./http-clients.js";

export { pythonEntrypointsContributor } from "./entrypoints.js";

// The Python parser with the framework layer's parse-time facts.
export const pythonFrameworkParser = createPythonParser([pythonFactsPlugin, pythonEnvPlugin, pythonDataPlugin, pythonHttpPlugin, pythonDiPlugin]);

// Routes (Flask, FastAPI, Starlette, Django, Django REST framework) and the
// entrypoints (Celery, click, typer, Django commands), then what hangs on them:
// data access (SQLAlchemy, SQLModel, Django ORM, DB-API SQL), env and settings
// reads, the `.env` values of request URLs, and dependency injection. All
// finished once every file is parsed.
export const pythonRoutesContributor: ISemanticContributor = {
  async contribute(graph, rootPath, _report, files) {
    const context = await createPythonContext(graph, rootPath);
    if (!context) return;
    const { handlerIds } = addPythonRoutes(context);
    addPythonCommands(context, handlerIds);
    addPythonDataAccess(context);
    addPythonEnv(context);
    await addPythonHttpEnv(context, rootPath, files);
    addPythonDi(context);
  },
};
