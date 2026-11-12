import { mountGraphView } from "./views/graph.js";
import { mountScanView } from "./views/scan.js";

const app = document.getElementById("app")!;

function showScan(): void {
  app.className = "";
  mountScanView(app, showGraph);
}
function showGraph(): void {
  app.className = "wide";
  mountGraphView(app, showScan);
}
showScan();
