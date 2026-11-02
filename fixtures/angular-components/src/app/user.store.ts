import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class UserStore {
  all(url: string) {
    return [{ name: url }];
  }
}
