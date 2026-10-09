import { createContext, Program, drawQuad, createNoiseTexture } from './gl.js';
import { Fluid3D } from './fluid.js';
import { OrbitCamera, vec3 } from './camera.js';
import { raymarch } from './shaders/render.js';
import { buildPanel } from './ui.js';

const canvas = document.getElementById('view');
const hud = document.getElementById('hud');

let gl;
try {
  gl = createContext(canvas);
} catch (e) {
  showError(e.message);
  throw e;
}

export const RESOLUTIONS = {
  'Baixa · 48×72×48': [48, 72, 48],
  'Média · 64×96×64': [64, 96, 64],
  'Alta · 80×120×80': [80, 120, 80],
  'Muito alta · 96×144×96': [96, 144, 96],
  'Ultra · 128×192×128': [128, 192, 128],
};

const fluid = new Fluid3D(gl, RESOLUTIONS['Média · 64×96×64']);
const camera = new OrbitCamera();
const renderProgram = new Program(gl, raymarch, 'raymarch');
const noiseTexture = createNoiseTexture(gl);

// Estado da aplicação (o painel lê e escreve aqui).
const app = {
  fluid,
  camera,
  paused: false,
  resolution: 'Média · 64×96×64',
  preset: 'Chaminé',
  emitter: { enabled: true, rate: 4, temp: 9, speed: 0.6, radius: 0.075, x: 0.5, z: 0.5 },
  brush: { radius: 0.06, force: 1.0, density: 25, temp: 0 },
  colorMode: 'Arco-íris',
  fixedColor: '#7fc8ff',
  autoRings: false,
  ringTimer: 0,
  look: {
    fire: false,
    densityScale: 16,
    lightSteps: 40,
    emission: 1.6,
    exposure: 1.0,
    stepFactor: 0.7,
    renderScale: 1.0,
    autoScale: true,
    showBox: true,
    detail: 0.8,
    detailScale: 3,
    lightDir: vec3.norm([0.75, 0.8, 0.35]),
    lightColor: [2.0, 1.88, 1.7],
    skyColor: [0.13, 0.16, 0.23],
  },
  timeScale: 1,
  touchMode: 'Pintar',
};

// ---------------------------------------------------------------- presets

const PRESETS = {
  'Chaminé'() {
    Object.assign(fluid.params, { buoyancy: 0.9, weight: 0.15, vorticity: 6, dyeDecay: 0.3, tempDecay: 0.6, wind: [0, 0, 0], openTop: true });
    Object.assign(app.emitter, { enabled: true, rate: 4, temp: 9, speed: 0.6, radius: 0.075, x: 0.5, z: 0.5 });
    Object.assign(fluid.sphere, { enabled: true, center: [0.5, 0.78, 0.5], radius: 0.13 });
    Object.assign(app.look, { fire: false, densityScale: 16 });
    app.colorMode = 'Arco-íris';
    app.autoRings = false;
  },
  'Fogueira'() {
    Object.assign(fluid.params, { buoyancy: 1.4, weight: 0.05, vorticity: 12, dyeDecay: 0.5, tempDecay: 1.3, wind: [0, 0, 0], openTop: true });
    Object.assign(app.emitter, { enabled: true, rate: 6, temp: 22, speed: 0.4, radius: 0.1, x: 0.5, z: 0.5 });
    fluid.sphere.enabled = false;
    Object.assign(app.look, { fire: true, densityScale: 30 });
    app.autoRings = false;
  },
  'Anéis de fumaça'() {
    Object.assign(fluid.params, { buoyancy: 0, weight: 0, vorticity: 1.5, dyeDecay: 0.04, tempDecay: 1, wind: [0, 0, 0], openTop: false });
    app.emitter.enabled = false;
    fluid.sphere.enabled = false;
    Object.assign(app.look, { fire: false, densityScale: 18 });
    app.colorMode = 'Arco-íris';
    app.autoRings = true;
    app.ringTimer = 0.2;
  },
  'Vento lateral'() {
    Object.assign(fluid.params, { buoyancy: 0.8, weight: 0.1, vorticity: 8, dyeDecay: 0.2, tempDecay: 0.6, wind: [0.9, 0, 0], openTop: true });
    Object.assign(app.emitter, { enabled: true, rate: 8, temp: 9, speed: 0.4, radius: 0.07, x: 0.25, z: 0.5 });
    Object.assign(fluid.sphere, { enabled: true, center: [0.62, 0.55, 0.5], radius: 0.12 });
    Object.assign(app.look, { fire: false, densityScale: 16 });
    app.colorMode = 'Branco';
    app.autoRings = false;
  },
  'Tela livre'() {
    Object.assign(fluid.params, { buoyancy: 0.3, weight: 0.05, vorticity: 5, dyeDecay: 0.08, tempDecay: 0.6, wind: [0, 0, 0], openTop: false });
    app.emitter.enabled = false;
    fluid.sphere.enabled = false;
    Object.assign(app.look, { fire: false, densityScale: 20 });
    app.colorMode = 'Arco-íris';
    app.autoRings = false;
  },
};

function applyPreset(name) {
  app.preset = name;
  fluid.clear();
  PRESETS[name]();
  clampSphere();
  panel.refresh();
}

function setResolution(name) {
  app.resolution = name;
  fluid.resize(RESOLUTIONS[name]);
  camera.target = vec3.scale(fluid.box, 0.5);
  clampSphere();
}

// ---------------------------------------------------------------- cores

function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

let simTime = 0;
function currentColor(offset = 0) {
  if (app.look.fire) return [1, 1, 1];
  if (app.colorMode === 'Branco') return [0.92, 0.92, 0.95];
  if (app.colorMode === 'Cor fixa') return hexToRgb(app.fixedColor);
  return hsv((simTime * 0.07 + offset) % 1, 0.85, 1);
}

// ---------------------------------------------------------------- ações

function boxClamp(p, margin) {
  return p.map((v, i) => Math.min(fluid.box[i] - margin, Math.max(margin, v)));
}

function clampSphere() {
  const s = fluid.sphere;
  s.center = boxClamp(s.center, s.radius + 2 * fluid.h);
}

function fireRing(origin, dir) {
  const r = 0.16;
  fluid.addSplat({
    pos: boxClamp(origin, r + 0.02), radius: r, shape: 1, axis: vec3.norm(dir),
    vel: vec3.scale(vec3.norm(dir), 2.6), density: 60, color: currentColor(0.5),
  });
}

function explode(pos) {
  fluid.addSplat({
    pos: boxClamp(pos, 0.05), radius: 0.09, shape: 2,
    vel: [2.5, 0, 0], temp: 25, density: 35, color: currentColor(0.25),
  });
}

function ringFromPointer() {
  const p = pointer.inside ? camera.pickOnPlane(pointer.u, pointer.v, camera.target) : camera.target;
  const dir = camera.forward;
  fireRing(vec3.sub(p || camera.target, vec3.scale(dir, 0.35)), dir);
}

function explodeAtPointer() {
  const p = pointer.inside ? camera.pickOnPlane(pointer.u, pointer.v, camera.target) : null;
  explode(p || [fluid.box[0] * 0.5, fluid.box[1] * 0.35, fluid.box[2] * 0.5]);
}

const actions = {
  ring: ringFromPointer,
  explode: explodeAtPointer,
  clear: () => fluid.clear(),
  pause: () => { app.paused = !app.paused; panel.refresh(); },
  preset: applyPreset,
  resolution: setResolution,
};

const panel = buildPanel(document.getElementById('panel'), app, actions, Object.keys(PRESETS), Object.keys(RESOLUTIONS));

// ---------------------------------------------------------------- entrada

const pointer = { u: 0.5, v: 0.5, inside: false, mode: null, last: null, anchor: null, id: null };

function toUV(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
}

function sphereHit(u, v) {
  const s = fluid.sphere;
  if (!s.enabled) return false;
  const { origin, dir } = camera.ray(u, v);
  const o = vec3.sub(origin, s.center);
  const b = vec3.dot(o, dir);
  const c = vec3.dot(o, o) - s.radius * s.radius * 1.15;
  return b * b - c > 0 && -b > 0;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [u, v] = toUV(e);
  Object.assign(pointer, { u, v, inside: true, id: e.pointerId, last: [e.clientX, e.clientY] });
  const orbit = e.button === 2 || e.button === 1 || e.shiftKey || app.touchMode === 'Girar câmera';
  if (orbit) {
    pointer.mode = 'orbit';
  } else if (sphereHit(u, v)) {
    pointer.mode = 'sphere';
    pointer.anchor = camera.pickOnPlane(u, v, fluid.sphere.center);
    pointer.grabOffset = vec3.sub(fluid.sphere.center, pointer.anchor);
  } else {
    pointer.mode = 'paint';
    pointer.anchor = camera.pickOnPlane(u, v, camera.target);
    pointer.prevWorld = pointer.anchor;
  }
});

canvas.addEventListener('pointermove', (e) => {
  const [u, v] = toUV(e);
  pointer.u = u;
  pointer.v = v;
  pointer.inside = true;
  if (pointer.mode === 'orbit') {
    camera.orbit(e.clientX - pointer.last[0], e.clientY - pointer.last[1]);
    pointer.last = [e.clientX, e.clientY];
  } else if (pointer.mode === 'sphere') {
    const p = camera.pickOnPlane(u, v, fluid.sphere.center);
    if (p) pointer.sphereTarget = vec3.add(p, pointer.grabOffset);
  } else if (pointer.mode === 'paint') {
    pointer.paintWorld = camera.pickOnPlane(u, v, camera.target);
  }
});

function endPointer(e) {
  if (pointer.id !== e.pointerId) return;
  pointer.mode = null;
  pointer.sphereTarget = null;
  pointer.paintWorld = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { pointer.inside = false; });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.zoom(Math.exp(e.deltaY * 0.001));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); actions.pause(); }
  else if (k === 'r') ringFromPointer();
  else if (k === 'e') explodeAtPointer();
  else if (k === 'c') fluid.clear();
  else if (k === 'b') { fluid.sphere.enabled = !fluid.sphere.enabled; panel.refresh(); }
  else if (k === 'f') { app.look.fire = !app.look.fire; panel.refresh(); }
  else if (k === 'h') document.getElementById('panel').classList.toggle('hidden');
  else if (k >= '1' && k <= '9') {
    const names = Object.keys(PRESETS);
    const i = Number(k) - 1;
    if (i < names.length) applyPreset(names[i]);
  }
});

// ---------------------------------------------------------------- loop

function updateInputs(dt) {
  // Pincel: injeta corante e um impulso na direção do arrasto.
  if (pointer.mode === 'paint' && pointer.paintWorld) {
    const p = pointer.paintWorld;
    const prev = pointer.prevWorld || p;
    let vel = vec3.scale(vec3.sub(p, prev), app.brush.force / Math.max(dt, 1e-3));
    const sp = vec3.len(vel);
    if (sp > 6) vel = vec3.scale(vel, 6 / sp);
    fluid.addSplat({
      pos: boxClamp(p, 0.01), radius: app.brush.radius, vel: vec3.scale(vel, 0.6),
      temp: app.brush.temp * dt, density: app.brush.density * dt, color: currentColor(),
    });
    pointer.prevWorld = p;
  }

  // Esfera: segue o mouse suavemente; sua velocidade entra na condição de contorno.
  const s = fluid.sphere;
  if (pointer.mode === 'sphere' && pointer.sphereTarget) {
    const old = s.center;
    const target = boxClamp(pointer.sphereTarget, s.radius + 2 * fluid.h);
    const k = 1 - Math.exp(-dt * 18);
    s.center = vec3.add(old, vec3.scale(vec3.sub(target, old), k));
    const v = vec3.scale(vec3.sub(s.center, old), 1 / Math.max(dt, 1e-3));
    const vl = vec3.len(v);
    s.vel = vl > 4 ? vec3.scale(v, 4 / vl) : v;
  } else {
    s.vel = vec3.scale(s.vel, Math.exp(-dt * 12));
  }

  // Emissor contínuo no fundo da caixa.
  const em = app.emitter;
  if (em.enabled) {
    const wob = 0.012 * Math.sin(simTime * 3.1);
    fluid.addSplat({
      pos: [em.x * fluid.box[0] + wob, 0.06, em.z * fluid.box[2]], radius: em.radius, shape: 3,
      vel: [0, em.speed, 0], temp: em.temp * dt, density: em.rate * dt, color: currentColor(),
    });
  }

  // Canhão automático de anéis.
  if (app.autoRings) {
    app.ringTimer -= dt;
    if (app.ringTimer <= 0) {
      app.ringTimer = 1.4;
      const a = (Math.random() - 0.5) * 0.5;
      const y = fluid.box[1] * (0.3 + Math.random() * 0.4);
      fireRing([0.16, y, fluid.box[2] * 0.5 + (Math.random() - 0.5) * 0.2], [Math.cos(a), (Math.random() - 0.5) * 0.3, Math.sin(a)]);
    }
  }
}

// Resolução dinâmica: ajusta a escala de renderização para manter o quadro
// entre ~40 e ~55 FPS. A simulação não muda; só o número de raios por quadro.
let scaleTimer = 0;
function adaptRenderScale(realDt, frameMs) {
  const L = app.look;
  if (!L.autoScale) return;
  scaleTimer += realDt;
  if (scaleTimer < 0.5) return;
  scaleTimer = 0;
  const old = L.renderScale;
  if (frameMs > 25) L.renderScale = Math.max(0.45, L.renderScale - 0.05);
  else if (frameMs < 18) L.renderScale = Math.min(1, L.renderScale + 0.05);
  if (L.renderScale !== old) panel.refresh();
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const scale = app.look.renderScale;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr * scale));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
}

function render(time) {
  const L = app.look;
  fluid.bake(L);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const s = fluid.sphere;
  const em = app.emitter;
  const glow = L.fire && em.enabled ? [em.x * fluid.box[0], 0.12, em.z * fluid.box[2], 0.5 + 0.03 * em.temp] : [0, 0, 0, 0];
  renderProgram.use().set({
    uVolA: fluid.volume.tex(0),
    uVolB: fluid.volume.tex(1),
    uNoise: noiseTexture,
    uInvViewProj: { mat4: camera.invViewProj },
    uCamPos: camera.position,
    uBox: fluid.box,
    uSphere: s.enabled ? [...s.center, s.radius] : [0, 0, 0, 0],
    uSphereColor: [0.75, 0.42, 0.22],
    uLightDir: L.lightDir,
    uLightColor: L.lightColor,
    uSkyColor: L.skyColor,
    uDensityScale: L.densityScale,
    uStep: fluid.h * L.stepFactor,
    uTime: simTime,
    uExposure: L.exposure,
    uShowBox: { i: L.showBox ? 1 : 0 },
    uFireMode: { i: L.fire ? 1 : 0 },
    uEmission: L.emission,
    uDetail: L.detail,
    uDetailScale: L.detailScale,
    uGlow: glow,
  });
  drawQuad(gl);
}

let lastT = performance.now();
let fps = 60, frameMs = 16;
function frame(now) {
  const realDt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  const dt = Math.min(realDt, 1 / 30) * app.timeScale;

  resizeCanvas();
  camera.update();

  if (!app.paused) {
    simTime += dt;
    updateInputs(dt);
    fluid.step(dt);
  } else {
    fluid.splats.length = 0;
  }
  render(now / 1000);

  frameMs = frameMs * 0.92 + realDt * 1000 * 0.08;
  fps = 1000 / frameMs;
  adaptRenderScale(realDt, frameMs);
  hud.textContent = `${fps.toFixed(0)} FPS · ${frameMs.toFixed(1)} ms · ${fluid.dims.join('×')} = ${(fluid.cellCount / 1e6).toFixed(2)} M células`
    + ` · render ${canvas.width}×${canvas.height}`
    + (app.paused ? ' · PAUSADO' : '');
  requestAnimationFrame(frame);
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.hidden = false;
}

window.addEventListener('error', (e) => showError(e.message));
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  showError('A GPU reiniciou e o contexto WebGL foi perdido.\n'
    + 'Recarregue a página (F5). Se persistir, reduza a grade ou a escala de renderização.');
});

// Parâmetros de URL, úteis para links e capturas de tela:
//   ?preset=Fogueira  &grade=Alta  &warmup=5 (segundos simulados antes do 1º quadro)
//   &ui=0 (esconde o painel)  &yaw=0.6&pitch=0.25&dist=2.9 (câmera)
const query = new URLSearchParams(location.search);
camera.target = vec3.scale(fluid.box, 0.5);
const gradeParam = query.get('grade');
if (gradeParam) {
  const name = Object.keys(RESOLUTIONS).find((k) => k.toLowerCase().startsWith(gradeParam.toLowerCase()));
  if (name) setResolution(name);
}
const presetParam = query.get('preset');
applyPreset(PRESETS[presetParam] ? presetParam : 'Chaminé');
if (query.get('ui') === '0') document.getElementById('panel').classList.add('hidden');
for (const [key, prop] of [['yaw', 'yaw'], ['pitch', 'pitch'], ['dist', 'distance']]) {
  if (query.has(key)) camera[prop] = Number(query.get(key));
}

// O aquecimento roda em lotes pequenos, devolvendo o controle ao navegador entre
// eles: enfileirar segundos de trabalho de GPU de uma vez dispara o watchdog
// do driver e o navegador desliga o WebGL.
async function warmup(seconds) {
  const dt = 1 / 60;
  let steps = Math.round(seconds / dt);
  while (steps > 0) {
    const n = Math.min(steps, 10);
    for (let i = 0; i < n; i++) {
      simTime += dt;
      updateInputs(dt);
      fluid.step(dt);
    }
    steps -= n;
    gl.finish();
    await new Promise((r) => setTimeout(r, 0));
  }
}
warmup(Number(query.get('warmup')) || 0).then(() => requestAnimationFrame(frame));

// Exposto para depuração no console: app.advance(120) avança 2 s de simulação
// (em lotes, pelo mesmo motivo do aquecimento acima).
app.advance = async (steps, dt = 1 / 60) => {
  await warmup(steps * dt);
  resizeCanvas();
  camera.update();
  render(performance.now() / 1000);
};
window.app = app;
