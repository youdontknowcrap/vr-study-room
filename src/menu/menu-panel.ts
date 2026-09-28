/**
 * MenuPanel — a floating menu drawn with the 2D Canvas API onto a texture.
 *
 * Why a canvas and not HTML/UIKit? It is tiny, has zero dependencies, is one
 * draw call, and is easy to read: you can see exactly how every button is
 * drawn and hit-tested. (IWSDK's UIKitML is a great upgrade path later.)
 *
 * Buttons are rectangles in canvas pixels. To find what a ray/finger hits we
 * take the UV (0..1) texture coordinate of the hit point and convert it to
 * canvas pixels.
 */
import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';

export interface MenuButton {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const CANVAS_W = 512;
const CANVAS_H = 760;
/** Physical size: 26 cm wide. Comfortable to read at ~45 cm. */
const PANEL_W = 0.26;

export class MenuPanel {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private buttons: MenuButton[] = [];
  private hovered: string | null = null;
  private title = 'Study Room';
  private status = '';

  constructor() {
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(PANEL_W, (PANEL_W * CANVAS_H) / CANVAS_W),
      new MeshBasicMaterial({ map: this.texture, transparent: true }),
    );
    this.mesh.visible = false;
  }

  /**
   * Describe the menu as rows of labels. Each row is split evenly into
   * buttons. Call again whenever a label changes (e.g. "Play" -> "Pause").
   */
  setRows(rows: { id: string; label: string }[][], status: string): void {
    const pad = 24;
    const top = 92;
    const rowH = 64;
    const gap = 10;
    this.buttons = [];
    rows.forEach((row, r) => {
      const w = (CANVAS_W - pad * 2 - gap * (row.length - 1)) / row.length;
      row.forEach((b, c) => {
        this.buttons.push({
          ...b,
          x: pad + c * (w + gap),
          y: top + r * (rowH + gap),
          w,
          h: rowH,
        });
      });
    });
    this.status = status;
    this.draw();
  }

  /** Which button is at texture coordinate (u, v)? */
  buttonAtUV(u: number, v: number): string | null {
    const px = u * CANVAS_W;
    const py = (1 - v) * CANVAS_H; // canvas y goes down, UV v goes up
    const b = this.buttons.find(
      (b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h,
    );
    return b?.id ?? null;
  }

  setHovered(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.draw(); // only redraw when something changes
  }

  private draw(): void {
    const g = this.ctx;
    g.clearRect(0, 0, CANVAS_W, CANVAS_H);
    roundRect(g, 0, 0, CANVAS_W, CANVAS_H, 28);
    g.fillStyle = 'rgba(28, 22, 18, 0.92)';
    g.fill();

    g.fillStyle = '#f3e6cf';
    g.font = 'bold 40px sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(this.title, 24, 48);

    g.font = '28px sans-serif';
    g.textAlign = 'center';
    for (const b of this.buttons) {
      roundRect(g, b.x, b.y, b.w, b.h, 14);
      g.fillStyle = b.id === this.hovered ? '#d9a55b' : '#4a3a2e';
      g.fill();
      g.fillStyle = b.id === this.hovered ? '#1c1612' : '#f3e6cf';
      g.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1, b.w - 12);
    }
    g.font = '22px sans-serif';
    g.fillStyle = '#bfae94';
    g.fillText(this.status, CANVAS_W / 2, CANVAS_H - 30, CANVAS_W - 40);
    this.texture.needsUpdate = true; // upload the new pixels to the GPU
  }
}

/** A small "Menu" tab that sits on the desk (reachable with hands). */
export function createMenuTab(): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 112;
  const g = c.getContext('2d')!;
  roundRect(g, 0, 0, 256, 112, 24);
  g.fillStyle = '#2b211b';
  g.fill();
  g.fillStyle = '#f3e6cf';
  g.font = 'bold 52px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('☰ Menu', 128, 58);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return new Mesh(
    new PlaneGeometry(0.1, 0.044),
    new MeshBasicMaterial({ map: tex, transparent: true }),
  );
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
