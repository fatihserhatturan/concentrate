import { createBrowserRouter, type RouteObject } from "react-router-dom";
import { App } from "./App";
import * as admin from "./pages/admin";

// Route objects, through a variable of the same file.
const routes = [
  {
    path: "/admin",
    Component: admin.AdminLayout,
    children: [
      { index: true, element: <admin.Dashboard /> },
      { path: "audit", Component: admin.AuditLog },
      { path: "/reports", lazy: () => import("./pages/Home") },
    ],
  },
  { path: "/*", element: <App /> },
] satisfies RouteObject[];

export const router = createBrowserRouter(routes);
