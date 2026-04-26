import { rootValue } from "@sample/pkg";
import { featureValue } from "@sample/pkg/feature";
import { double } from "@sample/pkg/utils/math";

export function run(): number {
  return double(rootValue + featureValue);
}
