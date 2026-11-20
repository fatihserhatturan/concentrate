import type { GraphSchemaExtension } from "../../../core/graph/schema.js";

// C/C++ build properties of a package: its CMake target type and build file.
export const cppBuildGraphSchema: GraphSchemaExtension = {
  id: "cpp-build",
  nodeProperties: [
    { label: "Package", after: "workspaceRoot", properties: { targetType: "STRING", buildFile: "STRING" } },
  ],
};
