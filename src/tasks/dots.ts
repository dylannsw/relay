// The Home banner, drawn on the graphics card (WebGL 2) as a dot matrix in the picture's own colours.
//
// Every frame, a small shader works out each dot from the picture: which grid cell a pixel is
// in, the colour at that cell's centre, and the dot's size from how light it is. Nothing is
// precomputed for one size, so resizing the window or dragging the picture redraws at full
// quality every frame, with the dots always the same 3.5px apart.
//
// Dark theme: lit dots, brighter = bigger. Light theme: ink dots, darker = bigger, with a larger
// minimum so the picture still reads on a white page. The fade into the page is drawn here too
// (the picture goes transparent), so no separate layer can leave a seam at the bottom edge.

/** Distance between dot centres, in CSS pixels. */
export const PITCH = 3.5;
/** Pictures larger than this (longest side) are scaled down when loaded; dots never need more. */
const MAX_SIDE = 4096;

const VERTEX = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_view;      // banner size, CSS px
uniform float u_ratio;    // device pixels per CSS px
uniform vec2 u_imageSize; // picture size, px
uniform float u_position; // 0 shows the picture's top, 1 its bottom
uniform float u_pitch;
uniform float u_dark;     // 1 in the dark theme
uniform float u_dots;     // 0 draws the plain picture
uniform float u_reveal;   // 0 → 1 while the dots grow in
out vec4 color;

float hash(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }

// The fade into the page: the picture is fully there down to 30% of the banner's height, then
// eases out to nothing at the bottom edge (the page shows through, white or black).
float fade(float y) {
  float t = clamp((y / u_view.y - 0.30) / 0.70, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

void main() {
  // This pixel in CSS px from the banner's top-left corner.
  vec2 p = vec2(gl_FragCoord.x, u_view.y * u_ratio - gl_FragCoord.y) / u_ratio;
  // The picture covers the banner's width; the position slides it up and down.
  float scale = max(u_view.x / u_imageSize.x, u_view.y / u_imageSize.y);
  vec2 drawn = u_imageSize * scale;
  vec2 offset = vec2((u_view.x - drawn.x) * 0.5, (u_view.y - drawn.y) * u_position);

  if (u_dots < 0.5) {
    color = texture(u_image, (p - offset) / drawn) * fade(p.y);
    return;
  }

  vec2 cell = floor(p / u_pitch);
  vec2 centre = (cell + 0.5) * u_pitch;
  // Average the picture over the whole cell (a mip level about one cell wide), not one pixel.
  float lod = log2(max(u_pitch / scale, 1.0));
  vec4 s = textureLod(u_image, (centre - offset) / drawn, lod);
  if (s.a < 0.03) discard;
  vec3 rgb = s.rgb / s.a;
  float light = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float size = u_dark > 0.5 ? 0.22 + 0.7 * sqrt(light) : 0.58 + 0.42 * sqrt(1.0 - light);
  float r = u_pitch * 0.5 * size;
  if (u_reveal < 1.0) {
    float shown = clamp((u_reveal * 1.6 - hash(cell) * 0.6) / 0.4, 0.0, 1.0);
    r *= 1.0 - pow(1.0 - shown, 3.0);
  }
  // Antialiased edge, one device pixel wide.
  float alpha = clamp((r - length(p - centre)) * u_ratio + 0.5, 0.0, 1.0) * s.a * fade(centre.y);
  if (u_dark < 0.5) rgb = pow(rgb, vec3(1.12)); // a touch deeper, so ink dots hold on white
  color = vec4(rgb * alpha, alpha);
}`;

export interface DrawOptions {
  /** 0–100: 0 shows the picture's top, 100 its bottom. */
  position: number;
  dark: boolean;
  dots: boolean;
  /** 0 → 1 while the dots grow in; 1 when done. */
  reveal: number;
}

/** Draws a picture into a canvas as dots (or plain). Throws if WebGL 2 isn't available. */
export class DotRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private imageSize: [number, number] = [1, 1];
  private hasImage = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error("WebGL 2 isn't available");
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    for (const name of ["u_image", "u_view", "u_ratio", "u_imageSize", "u_position", "u_pitch", "u_dark", "u_dots", "u_reveal"]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    // One triangle that covers the whole canvas.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture()!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  setImage(image: ImageBitmap): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.imageSize = [image.width, image.height];
    this.hasImage = true;
  }

  /** Draw at the canvas's current CSS size. */
  draw(o: DrawOptions): void {
    const { gl, canvas } = this;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h || !this.hasImage) return;
    const width = Math.round(w * ratio);
    const height = Math.round(h * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.uniforms;
    gl.uniform1i(u.u_image!, 0);
    gl.uniform2f(u.u_view!, w, h);
    gl.uniform1f(u.u_ratio!, ratio);
    gl.uniform2f(u.u_imageSize!, this.imageSize[0], this.imageSize[1]);
    gl.uniform1f(u.u_position!, Math.min(100, Math.max(0, o.position)) / 100);
    gl.uniform1f(u.u_pitch!, PITCH);
    gl.uniform1f(u.u_dark!, o.dark ? 1 : 0);
    gl.uniform1f(u.u_dots!, o.dots ? 1 : 0);
    gl.uniform1f(u.u_reveal!, o.reveal);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Frees the GPU resources. The canvas's context stays usable (React may reuse the canvas). */
  destroy(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

export interface Picture {
  bitmap: ImageBitmap;
  /** An object URL of the picture, for the plain fallback when WebGL isn't available. */
  url: string;
}

/** Decode picture bytes (scaled down if huge). */
export async function decodePicture(bytes: ArrayBuffer, path: string): Promise<Picture> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const blob = new Blob([bytes], { type: MIME[ext] ?? "image/png" });
  // The shader expects premultiplied colour (ImageBitmaps ignore WebGL's unpack setting).
  let bitmap = await createImageBitmap(blob, { premultiplyAlpha: "premultiply" });
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest > MAX_SIDE) {
    const k = MAX_SIDE / longest;
    const smaller = await createImageBitmap(blob, {
      premultiplyAlpha: "premultiply",
      resizeWidth: Math.round(bitmap.width * k),
      resizeHeight: Math.round(bitmap.height * k),
      resizeQuality: "high",
    });
    bitmap.close();
    bitmap = smaller;
  }
  return { bitmap, url: URL.createObjectURL(blob) };
}

/** How much taller than the banner the picture is once it covers the banner's width (CSS px). */
export function overflow(picture: Picture | undefined, w: number, h: number): number {
  if (!picture || !w || !h) return 0;
  const { width, height } = picture.bitmap;
  return height * Math.max(w / width, h / height) - h;
}
