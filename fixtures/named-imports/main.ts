import { format } from './utils-a';
import { format as fmt } from './utils-b';
import * as A from './utils-a';

export function run(): void {
  format('hello');
  fmt('world');
  A.parse('42');
}
