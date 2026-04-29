type Repository = {
  find(id: string): string;
};

type Logger = {
  info(message: string): void;
};

export class AccountService {
  constructor(
    private readonly repository: Repository,
    protected logger?: Logger,
    public displayName: string = "accounts",
    readonly serviceId: string,
    retries: number = 3,
  ) {}

  find(id: string): string {
    return this.repository.find(id);
  }
}
