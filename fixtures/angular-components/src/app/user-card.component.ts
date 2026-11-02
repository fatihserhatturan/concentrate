import { Component, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { AvatarComponent } from './shared/avatar.component';

@Component({
  selector: 'app-user-card',
  imports: [AvatarComponent],
  template: `
    <div class="card" (click)="choose()">
      <app-avatar [src]="user.avatar" size="32" />
      <app-badge [count]="1"></app-badge>
      <span (mouseenter)="highlighted = true">{{ title }}</span>
    </div>
  `,
})
export class UserCardComponent {
  @Input() user!: { name: string; avatar: string };
  @Input('heading') title = '';
  @Output() select = new EventEmitter<{ name: string }>();
  highlighted = false;

  choose() {
    this.select.emit(this.user);
  }

  @HostListener('mouseleave')
  onLeave() {
    this.highlighted = false;
  }
}
