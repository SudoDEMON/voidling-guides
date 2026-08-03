# VOiDling Assets

This folder contains the sprite sheet currently installed for the custom ChatGPT Work pet **VOiDling**.

## Character

- Tiny, smooth-2D shadow creature
- Orange horns
- Cyan-blue digital glow and eyes
- Curious, friendly behavior

## Sprite sheet

- File: `voidling-weightless-float.png`
- Format: transparent RGBA PNG
- Dimensions: 1536 x 1872 pixels
- Grid: 8 columns x 9 rows
- Cell size: 192 x 208 pixels

The populated-frame counts by row are:

`6, 8, 8, 4, 5, 8, 6, 6, 6`

Some cells at the end of shorter rows are intentionally empty. Treat transparency as the background and avoid rendering those unused cells.

## Web-project note

The sheet can be rendered with a canvas crop or CSS `background-position`. Each frame begins at:

- `sourceX = column * 192`
- `sourceY = row * 208`

For a responsive interface, render at any desired display size while preserving the cell aspect ratio of 12:13.

## Provenance

This is the updated weightless-float VOiDling asset installed on August 2, 2026.
The pet retains the original name and description: "A tiny shadow companion
with orange horns, blue digital glow, and a curious eye for your work."
