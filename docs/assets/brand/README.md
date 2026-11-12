# Brand

The Concentrate mark is the word itself, drawn by hand as SVG paths: no font
file is involved. Every stroke that ends, ends in a graph node.

| File | Use |
| --- | --- |
| `logo-dark.svg`, `logo-light.svg` | icon and wordmark side by side; `dark` goes on dark backgrounds |
| `wordmark-dark.svg`, `wordmark-light.svg` | the wordmark alone |
| `icon.svg` | the app icon, 32 px and larger |
| `icon-16.svg` | the icon reduced to its ring and centre node, for 16 px |

The files are written by `node scripts/build-brand.mjs`, which also copies the
icon to `ui/web/public/favicon.svg`. Change the drawing there, not in the SVGs.
The UI draws the same paths inline (`Logo` and `Wordmark` in
`ui/web/src/components/Shell.tsx`) so they follow the theme.

## Construction

- Lowercase, monoline: stroke 5 on an x-height of 36, round caps and joins.
- Round letters are circles of radius 18; `t` rises 14 above the x-height.
- A node (radius 4.4) sits where a stroke ends: the two ends of `c`, the top
  and feet of stems, the tip of `r`, the top and tail of `t`, the open end of
  `e`. Joints and the `t` crossbar stay plain.
- The `o` is a ring around one node. It is the only node that is not a stroke
  end, and it is the icon: a ring around a node, with three edges out to three
  more.

## Colors

| | Dark | Light | Use |
| --- | --- | --- | --- |
| Background | `#14110F` | `#F6F1E7` | page |
| Ink | `#F4EFE6` | `#1A1613` | wordmark strokes, text |
| Amber | `#FF9A2E` | `#D2640A` | nodes, the icon tile (`#FF9A2E` in both) |
| Accent in the UI | `#FF9A2E` | `#A84D06` | links, primary buttons, focus |

The light amber of the mark is darker than the dark one so the nodes keep a
3:1 contrast on paper (3.35:1; `#FF9A2E` on `#14110F` is 8.88:1). The UI's
light accent is darker again because it is used for text: 5.00:1 on
`#F6F1E7`, and white on it is 5.63:1. The full token list, with the neutral
ramp, is in `ui/web/src/styles/tokens.css`.

## Use

- Keep clear space of one `o` (the ring's diameter) around the logo.
- Smallest sizes: wordmark 16 px high, `icon.svg` 32 px, `icon-16.svg` below that.
- Nodes are always amber and strokes always ink; do not recolor them, outline
  the mark, or set the name in a typeface next to the icon.
