import { addDataAccessRelationships } from "./resolution/data-access.js";
import { addPrismaSchemaGraph, loadPrismaSchemas } from "./prisma-schema.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Post-parse data-access semantic module.
// Detects Prisma, TypeORM, Sequelize, Knex, and Mongoose call patterns,
// traces ORM clients through imports and dependency injection, and adds
// ACCESSES_DATA relationships from service/repository methods to the
// corresponding DataModel nodes. Prisma schema files add the declared models,
// their tables and relations first, and Prisma calls link to those models;
// accesses to models with a table also get READS / WRITES to it.
export const dataAccessContributor: ISemanticContributor = {
  id: "js-ts.data-access",
  async contribute(graph, rootPath, report, files) {
    const prismaModels = addPrismaSchemaGraph(graph, await loadPrismaSchemas(rootPath, files, report));
    addDataAccessRelationships(graph, prismaModels);
  },
};
