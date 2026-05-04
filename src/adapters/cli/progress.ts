export class ProgressReporter {
  private lastLength = 0;
  private readonly isTTY: boolean;

  constructor() {
    this.isTTY = process.stderr.isTTY === true;
  }

  update(current: number, total: number, relativePath: string): void {
    if (!this.isTTY) return;
    const width = String(total).length;
    const label = `[${String(current).padStart(width)}/${total}]`;
    const message = `${label} ${relativePath}`;
    const columns = process.stderr.columns ?? 120;
    const truncated = message.length > columns ? message.substring(0, columns) : message;
    process.stderr.write(`\r${truncated.padEnd(this.lastLength)}`);
    this.lastLength = truncated.length;
  }

  clear(): void {
    if (this.isTTY && this.lastLength > 0) {
      process.stderr.write(`\r${" ".repeat(this.lastLength)}\r`);
      this.lastLength = 0;
    }
  }
}
