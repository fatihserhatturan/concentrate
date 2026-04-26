export class UserService {
  async greet(name: string): Promise<string> {
    return this.format(name);
  }

  private format(name: string): string {
    return `Hello, ${name}`;
  }
}

export function standalone(): void {
  console.log("standalone");
}

export async function fetchUser(id: string): Promise<void> {
  console.log(id);
}
