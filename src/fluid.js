// Solver de fumaça 3D na GPU (Stable Fluids, Stam 1999), com:
//   - advecção semi-Lagrangiana (velocidade) e MacCormack (corante);
//   - empuxo de Boussinesq e confinamento de vorticidade;
//   - projeção de pressão por Jacobi com chute inicial do passo anterior;
//   - obstáculo esférico móvel e topo aberto opcional.

import { Program, Target, DoubleTarget, Volume3D, drawQuad } from './gl.js';
import * as S from './shaders/fluid.js';

const MAX_SPLATS = 8;

export class Fluid3D {
  constructor(gl, dims) {
    this.gl = gl;
    this.programs = {};
    for (const name of ['advectVelocity', 'advectScalar', 'maccormack', 'splatVelocity', 'splatScalar',
      'curl', 'forces', 'divergence', 'jacobi', 'subtractGradient', 'scale', 'bakeVolume']) {
      this.programs[name] = new Program(gl, S[name], name);
    }
    this.params = {
      jacobiIterations: 24,
      vorticity: 6,
      buoyancy: 0.9,
      weight: 0.15,
      dyeDecay: 0.15,      // 1/s
      tempDecay: 0.6,      // 1/s
      velDecay: 0.02,      // 1/s
      maccormack: true,
      openTop: true,
      wind: [0, 0, 0],
      pressureWarmStart: 0.8,
    };
    this.sphere = { enabled: true, center: [0.5, 0.75, 0.5], radius: 0.13, vel: [0, 0, 0] };
    this.splats = [];
    this.resize(dims);
  }

  resize(dims) {
    this.dispose();
    const gl = this.gl;
    const [nx, ny, nz] = dims;
    this.dims = dims;
    this.h = 1 / nx;
    this.box = [nx * this.h, ny * this.h, nz * this.h];
    const tx = Math.ceil(Math.sqrt(nz));
    const ty = Math.ceil(nz / tx);
    this.tiles = [tx, ty];
    const W = nx * tx, H = ny * ty;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (W > max || H > max) throw new Error(`Atlas ${W}×${H} excede o limite de textura (${max}).`);

    this.velocity = new DoubleTarget(gl, W, H, 'rgba16f');
    this.scalar = new DoubleTarget(gl, W, H, 'rgba16f');
    this.pressure = new DoubleTarget(gl, W, H, 'r32f');
    this.hat = new Target(gl, W, H, 'rgba16f');
    this.bar = new Target(gl, W, H, 'rgba16f');
    this.div = new Target(gl, W, H, 'r32f');
    this.curlT = new Target(gl, W, H, 'rgba16f');
    this.volume = new Volume3D(gl, nx, ny, nz, 2);
  }

  dispose() {
    for (const k of ['velocity', 'scalar', 'pressure', 'hat', 'bar', 'div', 'curlT', 'volume']) {
      if (this[k]) this[k].dispose();
      this[k] = null;
    }
  }

  clear() {
    this.velocity.clear();
    this.scalar.clear();
    this.pressure.clear();
  }

  get cellCount() {
    return this.dims[0] * this.dims[1] * this.dims[2];
  }

  // Uniforms comuns a todos os passos.
  common() {
    const s = this.sphere;
    return {
      uN: { ivec: this.dims },
      uTiles: { ivec: this.tiles },
      uH: this.h,
      uInvH: 1 / this.h,
      uSphere: s.enabled ? [...s.center, s.radius] : [0, 0, 0, 0],
      uSphereVel: s.enabled ? s.vel : [0, 0, 0],
      uOpenTop: { i: this.params.openTop ? 1 : 0 },
    };
  }

  run(name, target, uniforms) {
    const p = this.programs[name].use();
    p.set(this.common());
    p.set(uniforms);
    target.bind();
    drawQuad(this.gl);
  }

  // Fila de fontes para o próximo passo. Ver formatos em shaders/fluid.js.
  addSplat({ pos, radius, vel = [0, 0, 0], temp = 0, color = [1, 1, 1], density = 0, shape = 0, axis = [0, 1, 0] }) {
    this.splats.push({ pos, radius, vel, temp, color, density, shape, axis });
  }

  applySplats() {
    while (this.splats.length) {
      const batch = this.splats.splice(0, MAX_SPLATS);
      const pos = new Float32Array(MAX_SPLATS * 4);
      const axis = new Float32Array(MAX_SPLATS * 4);
      const vel = new Float32Array(MAX_SPLATS * 4);
      const dye = new Float32Array(MAX_SPLATS * 4);
      batch.forEach((s, i) => {
        pos.set([...s.pos, s.radius], i * 4);
        axis.set([...s.axis, s.shape], i * 4);
        vel.set([...s.vel, s.temp], i * 4);
        dye.set([...s.color, s.density], i * 4);
      });
      const u = {
        uSplatCount: { i: batch.length },
        uSplatPos: { vec4array: pos },
        uSplatAxis: { vec4array: axis },
        uSplatVel: { vec4array: vel },
        uSplatDye: { vec4array: dye },
      };
      this.run('splatVelocity', this.velocity.write, { ...u, uVel: this.velocity.read });
      this.velocity.swap();
      this.run('splatScalar', this.scalar.write, { ...u, uSrc: this.scalar.read });
      this.scalar.swap();
    }
  }

  step(dt) {
    const P = this.params;

    // 1. Advecção da velocidade (e temperatura).
    this.run('advectVelocity', this.velocity.write, {
      uVel: this.velocity.read, uDt: dt,
      uVelDecay: Math.exp(-P.velDecay * dt), uTempDecay: Math.exp(-P.tempDecay * dt),
    });

    // 2. Advecção do corante com a velocidade do início do passo.
    const decay = Math.exp(-P.dyeDecay * dt);
    if (P.maccormack) {
      this.run('advectScalar', this.hat, { uVel: this.velocity.read, uSrc: this.scalar.read, uDt: dt, uDecay: 1 });
      this.run('advectScalar', this.bar, { uVel: this.velocity.read, uSrc: this.hat, uDt: -dt, uDecay: 1 });
      this.run('maccormack', this.scalar.write, {
        uVel: this.velocity.read, uPhi: this.scalar.read, uHat: this.hat, uBar: this.bar, uDt: dt, uDecay: decay,
      });
    } else {
      this.run('advectScalar', this.scalar.write, { uVel: this.velocity.read, uSrc: this.scalar.read, uDt: dt, uDecay: decay });
    }
    this.velocity.swap();
    this.scalar.swap();

    // 3. Fontes (emissor, mouse, anéis, explosões).
    this.applySplats();

    // 4. Forças de corpo: empuxo + confinamento de vorticidade + vento.
    this.run('curl', this.curlT, { uVel: this.velocity.read });
    this.run('forces', this.velocity.write, {
      uVel: this.velocity.read, uScalar: this.scalar.read, uCurl: this.curlT, uDt: dt,
      uBuoyancy: P.buoyancy, uWeight: P.weight, uVorticity: P.vorticity, uWind: P.wind,
    });
    this.velocity.swap();

    // 5. Projeção: ∇²p = ∇·u, u ← u − ∇p.
    this.run('divergence', this.div, { uVel: this.velocity.read });
    this.run('scale', this.pressure.write, { uSrc: this.pressure.read, uScale: P.pressureWarmStart });
    this.pressure.swap();
    for (let i = 0; i < P.jacobiIterations; i++) {
      this.run('jacobi', this.pressure.write, { uPressure: this.pressure.read, uDiv: this.div });
      this.pressure.swap();
    }
    this.run('subtractGradient', this.velocity.write, { uVel: this.velocity.read, uPressure: this.pressure.read });
    this.velocity.swap();
  }

  // Copia o estado para os volumes 3D de renderização, com a iluminação pré-calculada.
  bake(look) {
    const gl = this.gl;
    const p = this.programs.bakeVolume.use();
    const [nx, ny, nz] = this.dims;
    p.set(this.common());
    p.set({
      uScalar: this.scalar.read,
      uVel: this.velocity.read,
      uLightDir: look.lightDir,
      uDensityScale: look.densityScale,
      uLightSteps: { i: look.lightSteps },
      uFireMode: { i: look.fire ? 1 : 0 },
    });
    gl.viewport(0, 0, nx, ny);
    for (let z = 0; z < nz; z++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.volume.fbos[z]);
      gl.uniform1i(p.uniforms.uLayer, z);
      drawQuad(gl);
    }
  }
}
