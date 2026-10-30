// With baseUrl ".", a package import is tried against the project first.
import Link from "next/link";
import { util } from "src/util";
import { missing } from "@/missing";
import { gone } from "./gone";
import type { Shared } from "types";

export const all = [Link, util, missing, gone];
