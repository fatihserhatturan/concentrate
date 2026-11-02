import { Component, HostListener, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { UserService } from './user.service';
import { UserCardComponent } from './user-card.component';
import { UserListComponent } from './user-list.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [UserCardComponent, UserListComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {
  users = [{ name: 'Ada' }];
  current = this.users[0];
  query = '';
  private readonly userService = inject(UserService);

  constructor(private logger: LoggerService) {}

  refresh() {
    this.logger.log('refresh');
    return this.userService.load();
  }

  pick(user: { name: string }) {
    this.current = user;
  }

  save() {
    return this.current;
  }

  search(query: string) {
    return this.users.filter((user) => user.name.includes(query));
  }

  @HostListener('window:resize', ['$event'])
  onResize() {
    return window.innerWidth;
  }
}
