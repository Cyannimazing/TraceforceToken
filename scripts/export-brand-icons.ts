import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { ImageResponse } from "next/og";

// Export the selected AI-generated design at standard browser/platform sizes.
// ImageResponse rasterizes the same asset; it does not redraw or replace the mark.
async function main() {
const root = process.cwd();
const original = await readFile(join(root, "public/brand/traceforce-app-icon.png"));
const source = `data:image/png;base64,${original.toString("base64")}`;
for (const [size, destination] of [
  [32, "src/app/icon.png"],
  [180, "src/app/apple-icon.png"],
  [192, "public/brand/icon-192.png"],
  [512, "public/brand/icon-512.png"],
] as const) {
  const response = new ImageResponse(createElement("img", { src: source, width: size, height: size, alt: "" }), { width: size, height: size });
  const png = Buffer.from(await response.arrayBuffer());
  await writeFile(join(root, destination), png);
  if (size === 32) {
    // ICO supports an embedded PNG image without another image dependency.
    const header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[6] = 32;
    header[7] = 32;
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    await writeFile(join(root, "src/app/favicon.ico"), Buffer.concat([header, png]));
  }
  process.stdout.write(`${destination}: ${size}x${size}\n`);
}
}

void main().catch(() => { process.stderr.write("Brand icon export failed.\n"); process.exitCode = 1; });
