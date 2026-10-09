// Utilitários WebGL2: programas, texturas float e pares ping-pong.

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) throw new Error('Seu navegador não suporta WebGL2.');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('Extensão EXT_color_buffer_float indisponível (necessária para renderizar em texturas float).');
  }
  return gl;
}

function compile(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join('\n');
    console.error(numbered);
    throw new Error(`Erro ao compilar shader "${name}":\n${log}`);
  }
  return sh;
}

export const FULLSCREEN_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export class Program {
  constructor(gl, fsSource, name = 'shader', vsSource = FULLSCREEN_VS) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSource, name + '.vs'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSource, name));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`Erro ao linkar "${name}": ${gl.getProgramInfoLog(p)}`);
    }
    this.program = p;
    this.uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const base = info.name.replace(/\[0\]$/, '');
      this.uniforms[base] = gl.getUniformLocation(p, info.name);
    }
  }

  use() {
    this.gl.useProgram(this.program);
    this._unit = 0;
    return this;
  }

  // Define uniforms a partir de um objeto { nome: valor }. O tipo é inferido
  // pelo valor; inteiros precisam ser passados como { i: n }.
  set(values) {
    const gl = this.gl;
    for (const [name, v] of Object.entries(values)) {
      const loc = this.uniforms[name];
      if (loc === undefined || loc === null) continue;
      if (v instanceof WebGLTexture || (v && v.texture instanceof WebGLTexture)) {
        const tex = v instanceof WebGLTexture ? v : v.texture;
        const target = v.target || gl.TEXTURE_2D;
        gl.activeTexture(gl.TEXTURE0 + this._unit);
        gl.bindTexture(target, tex);
        gl.uniform1i(loc, this._unit++);
      } else if (typeof v === 'number') {
        gl.uniform1f(loc, v);
      } else if (typeof v === 'boolean') {
        gl.uniform1i(loc, v ? 1 : 0);
      } else if (v && v.i !== undefined) {
        gl.uniform1i(loc, v.i);
      } else if (v && v.ivec !== undefined) {
        const a = v.ivec;
        if (a.length === 2) gl.uniform2iv(loc, a);
        else if (a.length === 3) gl.uniform3iv(loc, a);
        else gl.uniform4iv(loc, a);
      } else if (v && v.mat4 !== undefined) {
        gl.uniformMatrix4fv(loc, false, v.mat4);
      } else if (v && v.vec3array !== undefined) {
        gl.uniform3fv(loc, v.vec3array);
      } else if (v && v.vec4array !== undefined) {
        gl.uniform4fv(loc, v.vec4array);
      } else if (v && v.floatarray !== undefined) {
        gl.uniform1fv(loc, v.floatarray);
      } else if (v && v.length !== undefined) {
        if (v.length === 2) gl.uniform2fv(loc, v);
        else if (v.length === 3) gl.uniform3fv(loc, v);
        else if (v.length === 4) gl.uniform4fv(loc, v);
      }
    }
    return this;
  }
}

let quadVao = null;
export function drawQuad(gl) {
  if (!quadVao) {
    quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(quadVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// Formatos de textura float. GPUs integradas são limitadas por banda de memória,
// então cada campo usa o menor formato que preserva a qualidade:
//   'rgba16f' para velocidade e corante, 'r32f' para pressão e divergência.
export const FORMATS = {
  rgba32f: (gl) => [gl.RGBA32F, gl.RGBA, gl.FLOAT],
  rgba16f: (gl) => [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
  r32f: (gl) => [gl.R32F, gl.RED, gl.FLOAT],
  r16f: (gl) => [gl.R16F, gl.RED, gl.HALF_FLOAT],
};

// Textura 2D float com framebuffer próprio (alvo de renderização).
export class Target {
  constructor(gl, w, h, format = 'rgba32f') {
    this.gl = gl;
    this.width = w;
    this.height = h;
    const [internal, fmt, type] = FORMATS[format](gl);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer ${format} incompleto: ${status}`);
    this.clear();
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  clear() {
    const gl = this.gl;
    this.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

export class DoubleTarget {
  constructor(gl, w, h, format) {
    this.read = new Target(gl, w, h, format);
    this.write = new Target(gl, w, h, format);
  }
  swap() {
    [this.read, this.write] = [this.write, this.read];
  }
  clear() {
    this.read.clear();
    this.write.clear();
  }
  dispose() {
    this.read.dispose();
    this.write.dispose();
  }
}

// Conjunto de texturas 3D RGBA16F (filtráveis por hardware) usadas só na
// renderização. Cada fatia z tem um framebuffer com todas as texturas
// anexadas, para o bake escrever em todas de uma vez (MRT).
export class Volume3D {
  constructor(gl, nx, ny, nz, count = 1) {
    this.gl = gl;
    this.dims = [nx, ny, nz];
    this.textures = [];
    for (let k = 0; k < count; k++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, nx, ny, nz, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
        gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      }
      this.textures.push(tex);
    }
    const attachments = this.textures.map((_, k) => gl.COLOR_ATTACHMENT0 + k);
    this.fbos = [];
    for (let z = 0; z < nz; z++) {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      this.textures.forEach((tex, k) => {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, tex, 0, z);
      });
      gl.drawBuffers(attachments);
      if (z === 0) {
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer 3D RGBA16F incompleto: ' + status);
      }
      this.fbos.push(fbo);
    }
  }

  // Textura k no formato aceito por Program.set().
  tex(k) {
    return { texture: this.textures[k], target: this.gl.TEXTURE_3D };
  }

  dispose() {
    for (const t of this.textures) this.gl.deleteTexture(t);
    for (const f of this.fbos) this.gl.deleteFramebuffer(f);
  }
}

// Ruído fBm 3D periódico (value noise), gerado uma vez na CPU. Usado para
// acrescentar detalhe abaixo da resolução da grade na hora de renderizar.
export function createNoiseTexture(gl, n = 32) {
  const rand = new Float32Array(n * n * n);
  let seed = 1234567;
  for (let i = 0; i < rand.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    rand[i] = seed / 4294967296;
  }
  const idx = (x, y, z) => ((z & (n - 1)) * n + (y & (n - 1))) * n + (x & (n - 1));
  const smooth = (t) => t * t * (3 - 2 * t);
  // Value noise periódico com período `period` células.
  const noise = (x, y, z, period) => {
    const s = n / period;
    const fx = x / s, fy = y / s, fz = z / s;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = smooth(fx - x0), ty = smooth(fy - y0), tz = smooth(fz - z0);
    const g = (a, b, c) => rand[idx((a % period) * 7, (b % period) * 13, (c % period) * 3)];
    const lerp = (a, b, t) => a + (b - a) * t;
    const x1 = (x0 + 1), y1 = (y0 + 1), z1 = (z0 + 1);
    return lerp(
      lerp(lerp(g(x0, y0, z0), g(x1, y0, z0), tx), lerp(g(x0, y1, z0), g(x1, y1, z0), tx), ty),
      lerp(lerp(g(x0, y0, z1), g(x1, y0, z1), tx), lerp(g(x0, y1, z1), g(x1, y1, z1), tx), ty), tz);
  };
  const data = new Uint8Array(n * n * n);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let v = 0, amp = 0.5, norm = 0;
        for (let o = 0, period = 2; o < 4; o++, period *= 2) {
          // Ondulação "billowy": 1 − |2n − 1| dá cara de nuvem/fumaça.
          v += amp * (1 - Math.abs(2 * noise(x, y, z, period) - 1));
          norm += amp;
          amp *= 0.5;
        }
        data[(z * n + y) * n + x] = Math.round((v / norm) * 255);
      }
    }
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, n, n, n, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  // Textura pequena (32³ = 32 KB) com mipmaps: cabe no cache da GPU. Com 64³ e
  // frequência alta o ray-marching ficava 6× mais lento numa GPU integrada.
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
    gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
  }
  return { texture: tex, target: gl.TEXTURE_3D };
}
