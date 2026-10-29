function Controller(path: string) {
  return (target: unknown) => target;
}

function GET(path: string) {
  return (target: unknown, key: string) => key;
}

@Controller('/local')
export class NotARoute {
  @GET('/x')
  handle() {
    return null;
  }
}
