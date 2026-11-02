import { Component, Input, NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-user-list, [appUserList]',
  standalone: false,
  templateUrl: './user-list.component.html',
})
export class UserListComponent {
  private items: Array<{ name: string }> = [];

  @Input()
  set users(value: Array<{ name: string }>) {
    this.items = value;
  }

  remove(index: number) {
    this.items.splice(index, 1);
  }
}

@NgModule({
  declarations: [UserListComponent],
  imports: [CommonModule],
})
export class UserListModule {}
