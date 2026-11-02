import { Component, input, model } from '@angular/core';

@Component({
  selector: 'app-avatar',
  template: '<img [src]="src()" [width]="px()" />',
  host: { '(click)': 'toggle()', '(document:keydown.escape)': 'zoom.set(1)' },
})
export class AvatarComponent {
  src = input.required<string>();
  px = input(24, { alias: 'size' });
  zoom = model(1);

  toggle() {
    this.zoom.update((value) => value * 2);
  }
}
