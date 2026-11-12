import type { JSX } from "preact";

// A small inline icon set (16px, currentColor); no icon font, no dependency.
const paths = {
  logo: "M3 8a5 5 0 1 1 10 0A5 5 0 0 1 3 8Zm5-2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  folder: "M1.75 3A1.75 1.75 0 0 0 0 4.75v6.5C0 12.216.784 13 1.75 13h12.5A1.75 1.75 0 0 0 16 11.25v-5.5A1.75 1.75 0 0 0 14.25 4H8.06L6.78 2.72A1.75 1.75 0 0 0 5.54 2.2H1.75Z",
  graph: "M3.5 1.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-9 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM5 4.6l5.7 2.2-.5 1.4L4.5 6Zm-.4 5.1.7-1.3 5.4-1.5.4 1.4Z",
  search: "M10.68 11.74a6 6 0 0 1-7.92-8.98 6 6 0 0 1 8.98 7.92l3.54 3.54-1.06 1.06ZM2.5 7a4.5 4.5 0 1 0 9 0 4.5 4.5 0 0 0-9 0Z",
  sun: "M8 11.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM8 0l1 2H7ZM8 16l-1-2h2ZM0 8l2-1v2ZM16 8l-2 1V7ZM2.3 2.3l2 .6-.7 1.4ZM13.7 13.7l-2-.6.7-1.4ZM2.3 13.7l.6-2 1.4.7ZM13.7 2.3l-.6 2-1.4-.7Z",
  moon: "M6 .3a7.7 7.7 0 1 0 9.7 9.7A6 6 0 0 1 6 .3Z",
  refresh: "M8 2.5a5.5 5.5 0 0 0-5.3 4H.7l2.8 3.3 2.8-3.3H4.3A3.7 3.7 0 1 1 8 11.7v1.8A5.5 5.5 0 1 0 8 2.5Z",
  x: "M3.7 2.3 8 6.6l4.3-4.3 1.4 1.4L9.4 8l4.3 4.3-1.4 1.4L8 9.4l-4.3 4.3-1.4-1.4L6.6 8 2.3 3.7Z",
  up: "M8 2 2.5 7.5l1.4 1.4L7 5.8V14h2V5.8l3.1 3.1 1.4-1.4Z",
  home: "M8 1 0 8h2v6h4v-4h4v4h4V8h2Z",
  git: "M15.7 7.3 8.7.3a1 1 0 0 0-1.4 0L5.8 1.8l1.8 1.8a1.2 1.2 0 0 1 1.5 1.5l1.8 1.8a1.2 1.2 0 1 1-.7.7L8.5 5.9v4.4a1.2 1.2 0 1 1-1-.1V5.8a1.2 1.2 0 0 1-.6-1.6L5.1 2.4.3 7.3a1 1 0 0 0 0 1.4l7 7a1 1 0 0 0 1.4 0l7-7a1 1 0 0 0 0-1.4Z",
  check: "M13.8 3.6 6 11.4 2.2 7.6.8 9l5.2 5.2 9.2-9.2Z",
  arrow: "M8.6 2.4 14.2 8l-5.6 5.6-1.4-1.4L10.4 9H2V7h8.4L7.2 3.8Z",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, ...rest }: { name: IconName } & JSX.SVGAttributes<SVGSVGElement>) {
  return (
    <svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...rest}>
      <path d={paths[name]} fill-rule="evenodd" />
    </svg>
  );
}
