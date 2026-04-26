export class UserService {
  greet(name: string): string {
    return this.format(name);
  }

  private format(name: string): string {
    return `Hello, ${name}`;
  }
}

export function standalone(): void {
  console.log("standalone");
}
