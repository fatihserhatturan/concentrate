import {
  nestjsModulesContributor,
  nestjsInjectionContributor,
  instanceMethodContributor,
} from "../../integrations/frameworks/js-ts/nestjs.js";
import { routePathContributor } from "../../integrations/frameworks/js-ts/fastify.js";
import { envConfigContributor } from "../../integrations/frameworks/js-ts/env-config.js";
import { dataAccessContributor } from "../../integrations/frameworks/js-ts/data-access.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";

export const semanticContributors: readonly ISemanticContributor[] = [
  nestjsModulesContributor,
  nestjsInjectionContributor,
  instanceMethodContributor,
  routePathContributor,
  envConfigContributor,
  dataAccessContributor,
];
