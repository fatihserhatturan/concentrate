export class BaseClient {
  request(): string {
    return "ok";
  }
}

export interface Retryable {
  retry(): void;
}
