import { Component, Input } from '@angular/core';

@Component({ selector: 'app-badge', template: '<b>{{ count }}</b>' })
export class BadgeComponent {
  @Input() count = 0;
}
