import { Component } from "@angular/core";

@Component({
  selector: "app-root",
  template: `<nav class="nav" [ngClass]="{ open: isOpen, 'is-wide': wide }" [class.sticky]="sticky"></nav>`,
})
export class AppComponent {
  isOpen = false;
  wide = false;
  sticky = true;
}
