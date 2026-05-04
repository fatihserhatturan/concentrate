import { GraphBuilder } from "../../../core/graph/builder.js";
import { addDataAccessRelationships } from "./resolution/data-access.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Post-parse data-access semantic module.
// Detects Prisma, TypeORM, Sequelize, Knex, and Mongoose call patterns,
// traces ORM clients through imports and dependency injection, and adds
// ACCESSES_DATA relationships from service/repository methods to the
// corresponding DataModel nodes.
export const dataAccessContributor: ISemanticContributor = {
  contribute(graph) {
    addDataAccessRelationships(graph as unknown as GraphBuilder);
  },
};
