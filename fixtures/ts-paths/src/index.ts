import {format} from "@/utils/format.js";
import {helper} from "@lib/helper";
import {internal} from "src/internal";

export function main(): string {
  return format(helper()) + internal();
}
