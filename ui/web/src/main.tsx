import { render } from "preact";
import { App } from "./App.js";
import { initTheme } from "./lib/theme.js";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/start.css";
import "./styles/graph.css";

initTheme();
render(<App />, document.getElementById("app")!);
