// Painel de controles simples, sem dependências. Cada controle lê e escreve
// diretamente em um objeto de estado; refresh() ressincroniza após presets.

export function buildPanel(root, app, actions, presetNames, resolutionNames) {
  const fluid = app.fluid;
  const P = fluid.params;
  const L = app.look;
  const bindings = [];

  root.innerHTML = '';
  const header = el('div', 'panel-header');
  header.innerHTML = '<span class="title">Fumaça 3D</span><span class="hint">H esconde</span>';
  root.append(header);

  function section(title, open = true) {
    const d = el('details', 'section');
    d.open = open;
    const s = el('summary');
    s.textContent = title;
    d.append(s);
    root.append(d);
    return d;
  }

  function row(parent, label) {
    const r = el('label', 'row');
    const span = el('span', 'label');
    span.textContent = label;
    r.append(span);
    parent.append(r);
    return r;
  }

  function slider(parent, label, obj, key, min, max, step, fmt = (v) => v.toFixed(2)) {
    const r = row(parent, label);
    const input = el('input');
    Object.assign(input, { type: 'range', min, max, step });
    const out = el('span', 'value');
    r.append(input, out);
    const sync = () => { input.value = obj()[key]; out.textContent = fmt(Number(obj()[key])); };
    input.addEventListener('input', () => {
      obj()[key] = Number(input.value);
      out.textContent = fmt(Number(input.value));
      if (key === 'renderScale') L.autoScale = false;
      refresh();
    });
    bindings.push(sync);
    sync();
  }

  function check(parent, label, obj, key) {
    const r = row(parent, label);
    r.classList.add('check');
    const input = el('input');
    input.type = 'checkbox';
    r.append(input);
    const sync = () => { input.checked = !!obj()[key]; };
    input.addEventListener('change', () => { obj()[key] = input.checked; });
    bindings.push(sync);
    sync();
  }

  function select(parent, label, options, get, set) {
    const r = row(parent, label);
    const s = el('select');
    for (const o of options) {
      const opt = el('option');
      opt.value = opt.textContent = o;
      s.append(opt);
    }
    r.append(s);
    const sync = () => { s.value = get(); };
    s.addEventListener('change', () => set(s.value));
    bindings.push(sync);
    sync();
    return s;
  }

  function buttons(parent, list) {
    const r = el('div', 'buttons');
    for (const [text, fn, title] of list) {
      const b = el('button');
      b.textContent = text;
      if (title) b.title = title;
      b.addEventListener('click', fn);
      r.append(b);
    }
    parent.append(r);
    return r;
  }

  // --- Cena
  const scene = section('Cena');
  select(scene, 'Preset', presetNames, () => app.preset, (v) => actions.preset(v));
  select(scene, 'Grade', resolutionNames, () => app.resolution, (v) => actions.resolution(v));
  const btns = buttons(scene, [
    ['Pausar', () => actions.pause(), 'Espaço'],
    ['Anel', () => actions.ring(), 'R: dispara um anel de vórtice'],
    ['Explosão', () => actions.explode(), 'E'],
    ['Limpar', () => actions.clear(), 'C'],
  ]);
  bindings.push(() => { btns.firstChild.textContent = app.paused ? 'Continuar' : 'Pausar'; });
  slider(scene, 'Velocidade do tempo', () => app, 'timeScale', 0.1, 2, 0.05);
  select(scene, 'Toque / botão esq.', ['Pintar', 'Girar câmera'], () => app.touchMode, (v) => { app.touchMode = v; });

  // --- Física
  const phys = section('Física');
  slider(phys, 'Empuxo (temperatura)', () => P, 'buoyancy', 0, 3, 0.05);
  slider(phys, 'Peso da fumaça', () => P, 'weight', 0, 1, 0.01);
  slider(phys, 'Confinamento de vorticidade', () => P, 'vorticity', 0, 25, 0.5, (v) => v.toFixed(1));
  slider(phys, 'Dissipação do corante', () => P, 'dyeDecay', 0, 2, 0.01);
  slider(phys, 'Resfriamento', () => P, 'tempDecay', 0, 3, 0.05);
  slider(phys, 'Iterações de Jacobi', () => P, 'jacobiIterations', 2, 80, 1, (v) => v.toFixed(0));
  slider(phys, 'Vento x', () => P.wind, 0, -3, 3, 0.05);
  slider(phys, 'Vento z', () => P.wind, 2, -3, 3, 0.05);
  check(phys, 'Advecção MacCormack', () => P, 'maccormack');
  check(phys, 'Topo aberto (saída)', () => P, 'openTop');

  // --- Fontes
  const src = section('Fontes e obstáculo', false);
  check(src, 'Emissor ligado', () => app.emitter, 'enabled');
  slider(src, 'Taxa de fumaça', () => app.emitter, 'rate', 0, 25, 0.5, (v) => v.toFixed(1));
  slider(src, 'Temperatura', () => app.emitter, 'temp', 0, 40, 0.5, (v) => v.toFixed(1));
  slider(src, 'Velocidade de saída', () => app.emitter, 'speed', 0, 2, 0.05);
  slider(src, 'Raio do emissor', () => app.emitter, 'radius', 0.02, 0.2, 0.005, (v) => v.toFixed(3));
  slider(src, 'Posição x', () => app.emitter, 'x', 0.1, 0.9, 0.01);
  slider(src, 'Posição z', () => app.emitter, 'z', 0.1, 0.9, 0.01);
  check(src, 'Esfera (arraste)', () => fluid.sphere, 'enabled');
  slider(src, 'Raio da esfera', () => fluid.sphere, 'radius', 0.04, 0.3, 0.005, (v) => v.toFixed(3));
  slider(src, 'Raio do pincel', () => app.brush, 'radius', 0.02, 0.2, 0.005, (v) => v.toFixed(3));
  slider(src, 'Força do pincel', () => app.brush, 'force', 0, 3, 0.05);
  slider(src, 'Calor do pincel', () => app.brush, 'temp', 0, 40, 0.5, (v) => v.toFixed(1));
  check(src, 'Canhão automático de anéis', () => app, 'autoRings');

  // --- Visual
  const vis = section('Visual', false);
  select(vis, 'Cor do corante', ['Arco-íris', 'Branco', 'Cor fixa'], () => app.colorMode, (v) => { app.colorMode = v; });
  const colorRow = row(vis, 'Cor fixa');
  const color = el('input');
  color.type = 'color';
  colorRow.append(color);
  color.addEventListener('input', () => { app.fixedColor = color.value; app.colorMode = 'Cor fixa'; refresh(); });
  bindings.push(() => { color.value = app.fixedColor; });
  check(vis, 'Modo fogo (emissão por temperatura)', () => L, 'fire');
  slider(vis, 'Densidade óptica', () => L, 'densityScale', 2, 120, 1, (v) => v.toFixed(0));
  slider(vis, 'Detalhe (ruído nas bordas)', () => L, 'detail', 0, 1.5, 0.05);
  slider(vis, 'Escala do detalhe', () => L, 'detailScale', 1, 8, 0.25, (v) => v.toFixed(2));
  slider(vis, 'Emissão do fogo', () => L, 'emission', 0, 5, 0.05);
  slider(vis, 'Exposição', () => L, 'exposure', 0.2, 3, 0.05);
  slider(vis, 'Passos de sombra', () => L, 'lightSteps', 0, 64, 1, (v) => v.toFixed(0));
  slider(vis, 'Passo do raio (× célula)', () => L, 'stepFactor', 0.3, 2, 0.05);
  check(vis, 'Resolução automática (~45 FPS)', () => L, 'autoScale');
  slider(vis, 'Escala de renderização', () => L, 'renderScale', 0.25, 1, 0.05);
  check(vis, 'Mostrar caixa', () => L, 'showBox');

  const help = el('div', 'help');
  help.innerHTML = `
    <b>Esquerdo</b> arrasta: pinta fumaça · sobre a esfera: move a esfera<br>
    <b>Direito</b> ou <b>Shift</b>+arrasto: gira · <b>roda</b>: zoom<br>
    <b>R</b> anel · <b>E</b> explosão · <b>C</b> limpa · <b>B</b> esfera · <b>F</b> fogo · <b>1–5</b> presets`;
  root.append(help);

  function refresh() {
    for (const b of bindings) b();
  }
  return { refresh };
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
