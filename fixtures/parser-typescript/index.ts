import { helper } from "./utils.js";

export interface UserRecord {
  id: string;
  name: string;
}

type UserId = string;

export enum UserRole {
  Admin,
  Member,
}

export function greet(name: string): string {
  return helper(name);
}

export const add = (a: number, b: number): number => a + b;

export const fetchData = async (url: string): Promise<string> => {
  return helper(url);
};

const _internal = (): void => {};

function Injectable() { return (target: any) => target; }
function Get(path: string) { return (_t: any, _k: string, d: any) => d; }
function Post(path: string) { return (_t: any, _k: string, d: any) => d; }

@Injectable()
class ApiController {
  @Get('/all')
  findAll(): string { return ''; }

  @Post('/create')
  create(): string { return ''; }
}

export abstract class BaseRepository {
  abstract findById(id: string): string;

  protected abstract save(): void;

  get kind(): string {
    return 'base';
  }
}

export class UserService {
  public userId: string = '';
  private password: string = '';
  protected role: string = '';
  readonly apiKey: string = '';
  static instanceCount: number = 0;
  #secret: string = '';
  name: string = '';

  get displayName(): string {
    return helper(this.name);
  }

  set displayName(value: string) {
    this.name = value;
  }

  getName(id: string): string {
    return helper(id);
  }

  async fetchUser(id: string): Promise<string> {
    return helper(id);
  }
}
