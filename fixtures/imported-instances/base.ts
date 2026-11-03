export class BaseClient {
  private token: string | null = null;

  setToken = (token: string | null) => {
    this.token = token;
  };

  get(path: string) {
    return fetch(path, { headers: this.token ? { authorization: this.token } : {} });
  }
}
