class BaseService {}

function Entity(): ClassDecorator {
  return () => {};
}

function Route(): MethodDecorator {
  return () => {};
}

export const Repository = @Entity() class extends BaseService {
  readonly tableName: string = "users";

  @Route()
  async save(id: string): Promise<string> {
    return id;
  }
};
