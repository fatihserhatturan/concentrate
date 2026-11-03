import { send } from "./http";

export class HttpClient {
  private securityData: string | null = null;
  timeout = 5000;

  public setSecurityData = (data: string | null) => {
    this.securityData = data;
  };

  protected request = async (path: string) => send(path, this.securityData);

  #log = function (message: string) {
    console.log(message);
  };

  static create = () => new HttpClient();

  login() {
    this.setSecurityData("token");
    this.#log("login");
    return this.request("/login");
  }
}

export function connect(client: HttpClient) {
  client.setSecurityData(null);
  return HttpClient.create();
}
