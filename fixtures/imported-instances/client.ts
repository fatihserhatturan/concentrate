import { BaseClient } from "./base";

export class Api extends BaseClient {
  users() {
    return this.get("/users");
  }
}
