import { Injectable, InjectionToken, inject } from '@angular/core';
import { UserStore } from './user.store';

export interface AppConfig {
  apiUrl: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('config');

@Injectable({ providedIn: 'root' })
export class UserService {
  private store = inject(UserStore);
  private config = inject<AppConfig>(APP_CONFIG);

  load() {
    return this.store.all(this.config.apiUrl);
  }
}
