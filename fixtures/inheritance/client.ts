import { BaseClient, Retryable } from "./base.js";

export class HttpClient extends BaseClient implements Retryable {
  retry(): void {}
}
