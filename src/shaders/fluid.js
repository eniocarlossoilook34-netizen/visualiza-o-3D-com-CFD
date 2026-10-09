// Shaders da simulação. A grade 3D (nx × ny × nz) fica guardada numa textura 2D
// "atlas": cada fatia z é um ladrilho nx × ny, e os ladrilhos são dispostos em
// uTiles.x colunas. Cada passo é um fragment shader que roda uma vez por célula.
//
// Convenções:
//   - célula (i,j,k) tem centro em ((i,j,k) + 0.5) * h no espaço do mundo;
//   - velocidade em unidades de mundo por segundo; 1/h = uInvH converte para células;
//   - textura de velocidade: xyz = u, w = temperatura (advectada junto);
//   - textura escalar: rgb = cor do corante (pré-multiplicada), a = densidade.

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform ivec3 uN;      // dimensões da grade
uniform ivec2 uTiles;  // ladrilhos do atlas (colunas, linhas)
uniform float uH;      // tamanho da célula (mundo)
uniform float uInvH;
uniform vec4 uSphere;  // obstáculo: centro (mundo) e raio
uniform vec3 uSphereVel;
uniform int uOpenTop;  // 1 = topo aberto (saída), 0 = caixa fechada

layout(location = 0) out vec4 outColor;

ivec2 atlasCoord(ivec3 c) {
  int tx = c.z % uTiles.x;
  int ty = c.z / uTiles.x;
  return ivec2(tx * uN.x + c.x, ty * uN.y + c.y);
}

// Célula correspondente ao fragmento atual. Retorna z = -1 em ladrilhos sobrando.
ivec3 voxel() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / uN.x;
  int ty = p.y / uN.y;
  int z = ty * uTiles.x + tx;
  if (z >= uN.z) return ivec3(-1);
  return ivec3(p.x - tx * uN.x, p.y - ty * uN.y, z);
}

vec4 fetch(sampler2D t, ivec3 c) {
  return texelFetch(t, atlasCoord(clamp(c, ivec3(0), uN - 1)), 0);
}

// Interpolação trilinear com p em coordenadas de célula (centros nos inteiros).
vec4 sampleTri(sampler2D t, vec3 p) {
  p = clamp(p, vec3(0.0), vec3(uN - 1));
  ivec3 i0 = ivec3(floor(p));
  ivec3 i1 = min(i0 + 1, uN - 1);
  vec3 f = p - vec3(i0);
  vec4 c000 = texelFetch(t, atlasCoord(ivec3(i0.x, i0.y, i0.z)), 0);
  vec4 c100 = texelFetch(t, atlasCoord(ivec3(i1.x, i0.y, i0.z)), 0);
  vec4 c010 = texelFetch(t, atlasCoord(ivec3(i0.x, i1.y, i0.z)), 0);
  vec4 c110 = texelFetch(t, atlasCoord(ivec3(i1.x, i1.y, i0.z)), 0);
  vec4 c001 = texelFetch(t, atlasCoord(ivec3(i0.x, i0.y, i1.z)), 0);
  vec4 c101 = texelFetch(t, atlasCoord(ivec3(i1.x, i0.y, i1.z)), 0);
  vec4 c011 = texelFetch(t, atlasCoord(ivec3(i0.x, i1.y, i1.z)), 0);
  vec4 c111 = texelFetch(t, atlasCoord(ivec3(i1.x, i1.y, i1.z)), 0);
  vec4 x00 = mix(c000, c100, f.x), x10 = mix(c010, c110, f.x);
  vec4 x01 = mix(c001, c101, f.x), x11 = mix(c011, c111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

// Mesma amostragem, devolvendo também mínimo e máximo dos 8 vizinhos
// (usado para limitar a correção de MacCormack e evitar oscilações).
vec4 sampleTriMinMax(sampler2D t, vec3 p, out vec4 lo, out vec4 hi) {
  p = clamp(p, vec3(0.0), vec3(uN - 1));
  ivec3 i0 = ivec3(floor(p));
  ivec3 i1 = min(i0 + 1, uN - 1);
  vec3 f = p - vec3(i0);
  vec4 c000 = texelFetch(t, atlasCoord(ivec3(i0.x, i0.y, i0.z)), 0);
  vec4 c100 = texelFetch(t, atlasCoord(ivec3(i1.x, i0.y, i0.z)), 0);
  vec4 c010 = texelFetch(t, atlasCoord(ivec3(i0.x, i1.y, i0.z)), 0);
  vec4 c110 = texelFetch(t, atlasCoord(ivec3(i1.x, i1.y, i0.z)), 0);
  vec4 c001 = texelFetch(t, atlasCoord(ivec3(i0.x, i0.y, i1.z)), 0);
  vec4 c101 = texelFetch(t, atlasCoord(ivec3(i1.x, i0.y, i1.z)), 0);
  vec4 c011 = texelFetch(t, atlasCoord(ivec3(i0.x, i1.y, i1.z)), 0);
  vec4 c111 = texelFetch(t, atlasCoord(ivec3(i1.x, i1.y, i1.z)), 0);
  lo = min(min(min(c000, c100), min(c010, c110)), min(min(c001, c101), min(c011, c111)));
  hi = max(max(max(c000, c100), max(c010, c110)), max(max(c001, c101), max(c011, c111)));
  vec4 x00 = mix(c000, c100, f.x), x10 = mix(c010, c110, f.x);
  vec4 x01 = mix(c001, c101, f.x), x11 = mix(c011, c111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

vec3 worldPos(ivec3 c) { return (vec3(c) + 0.5) * uH; }

bool inSphere(ivec3 c) {
  if (uSphere.w <= 0.0) return false;
  vec3 d = worldPos(c) - uSphere.xyz;
  return dot(d, d) < uSphere.w * uSphere.w;
}

// Classificação de uma célula vizinha: 0 = fluido, 1 = parede/obstáculo, 2 = saída aberta.
int cellType(ivec3 c) {
  if (c.y >= uN.y) return uOpenTop == 1 ? 2 : 1;
  if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, uN))) return 1;
  if (inSphere(c)) return 1;
  return 0;
}
`;

// ---------------------------------------------------------------- advecção

// Semi-Lagrangiano para a velocidade (+ temperatura no canal w).
export const advectVelocity = HEADER + `
uniform sampler2D uVel;
uniform float uDt;
uniform float uVelDecay;
uniform float uTempDecay;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  vec3 v = fetch(uVel, c).xyz;
  vec3 p = vec3(c) - uDt * v * uInvH;
  vec4 r = sampleTri(uVel, p);
  r.xyz *= uVelDecay;
  r.w *= uTempDecay;
  outColor = r;
}`;

// Semi-Lagrangiano genérico para o campo escalar. uSign = +1 (passo à frente)
// ou -1 (passo de volta, usado pelo MacCormack).
export const advectScalar = HEADER + `
uniform sampler2D uVel;
uniform sampler2D uSrc;
uniform float uDt;
uniform float uDecay;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  vec3 v = fetch(uVel, c).xyz;
  vec3 p = vec3(c) - uDt * v * uInvH;
  vec4 r = sampleTri(uSrc, p) * uDecay;
  if (inSphere(c)) r = vec4(0.0);
  outColor = r;
}`;

// Correção de MacCormack: phi_new = phiHat + (phi - phiBar)/2, limitada ao
// intervalo dos vizinhos no ponto de partida (Selle et al., 2008).
export const maccormack = HEADER + `
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform sampler2D uHat;
uniform sampler2D uBar;
uniform float uDt;
uniform float uDecay;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  if (inSphere(c)) { outColor = vec4(0.0); return; }
  vec3 v = fetch(uVel, c).xyz;
  vec3 p = vec3(c) - uDt * v * uInvH;
  vec4 lo, hi;
  sampleTriMinMax(uPhi, p, lo, hi);
  vec4 hat = fetch(uHat, c);
  vec4 r = hat + 0.5 * (fetch(uPhi, c) - fetch(uBar, c));
  r = clamp(r, lo * uDecay, hi * uDecay);
  outColor = max(r, vec4(0.0));
}`;

// ---------------------------------------------------------------- fontes

// Até 8 "splats" por passo. Cada um tem posição, raio, eixo e formato:
//   formato 0 = impulso gaussiano esférico (soma velocidade),
//   formato 1 = impulso em disco (gera anéis de vórtice),
//   formato 2 = explosão radial (velocidade aponta para fora do centro),
//   formato 3 = emissor: a velocidade tende ao valor alvo em vez de somar.
// Quantidades de corante e temperatura já chegam multiplicadas por dt quando
// a fonte é contínua (feito no JavaScript).
const SPLAT_COMMON = `
#define MAX_SPLATS 8
uniform int uSplatCount;
uniform vec4 uSplatPos[MAX_SPLATS];   // xyz = centro, w = raio
uniform vec4 uSplatAxis[MAX_SPLATS];  // xyz = eixo (disco), w = formato
uniform vec4 uSplatVel[MAX_SPLATS];   // xyz = velocidade, w = temperatura
uniform vec4 uSplatDye[MAX_SPLATS];   // rgb = cor, a = densidade

float splatWeight(int i, vec3 wp, out vec3 radial) {
  vec3 d = wp - uSplatPos[i].xyz;
  float r = uSplatPos[i].w;
  int shape = int(uSplatAxis[i].w + 0.5);
  radial = d / max(length(d), 1e-5);
  if (shape == 1) {
    vec3 ax = uSplatAxis[i].xyz;
    float along = dot(d, ax);
    float rad = length(d - along * ax);
    float th = r * 0.35;
    return exp(-along * along / (th * th)) * (1.0 - smoothstep(r * 0.7, r, rad));
  }
  return exp(-dot(d, d) / (r * r));
}

// Toro na borda do disco: é onde se forma o núcleo do anel de vórtice.
float torusWeight(int i, vec3 wp) {
  vec3 d = wp - uSplatPos[i].xyz;
  float r = uSplatPos[i].w;
  vec3 ax = uSplatAxis[i].xyz;
  float along = dot(d, ax);
  float rad = length(d - along * ax);
  float tube = r * 0.2;
  vec2 q = vec2(rad - r * 0.82, along);
  return exp(-dot(q, q) / (tube * tube));
}
`;

export const splatVelocity = HEADER + SPLAT_COMMON + `
uniform sampler2D uVel;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  vec4 v = fetch(uVel, c);
  vec3 wp = worldPos(c);
  for (int i = 0; i < MAX_SPLATS; i++) {
    if (i >= uSplatCount) break;
    vec3 radial;
    float g = splatWeight(i, wp, radial);
    int shape = int(uSplatAxis[i].w + 0.5);
    vec3 dv = shape == 2 ? radial * length(uSplatVel[i].xyz) : uSplatVel[i].xyz;
    if (shape == 3) v.xyz = mix(v.xyz, dv, g);
    else v.xyz += dv * g;
    v.w += uSplatVel[i].w * g;
  }
  outColor = v;
}`;

export const splatScalar = HEADER + SPLAT_COMMON + `
uniform sampler2D uSrc;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  vec4 s = fetch(uSrc, c);
  vec3 wp = worldPos(c);
  for (int i = 0; i < MAX_SPLATS; i++) {
    if (i >= uSplatCount) break;
    vec3 radial;
    float g = int(uSplatAxis[i].w + 0.5) == 1 ? torusWeight(i, wp) : splatWeight(i, wp, radial);
    float a = uSplatDye[i].a * g;
    s += vec4(uSplatDye[i].rgb * a, a);
  }
  if (inSphere(c)) s = vec4(0.0);
  outColor = s;
}`;

// ---------------------------------------------------------------- forças

// Vorticidade ω = ∇ × u (xyz) e |ω| (w).
export const curl = HEADER + `
uniform sampler2D uVel;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  vec3 L = fetch(uVel, c - ivec3(1, 0, 0)).xyz;
  vec3 R = fetch(uVel, c + ivec3(1, 0, 0)).xyz;
  vec3 D = fetch(uVel, c - ivec3(0, 1, 0)).xyz;
  vec3 U = fetch(uVel, c + ivec3(0, 1, 0)).xyz;
  vec3 B = fetch(uVel, c - ivec3(0, 0, 1)).xyz;
  vec3 F = fetch(uVel, c + ivec3(0, 0, 1)).xyz;
  vec3 w = 0.5 * uInvH * vec3(
    (U.z - D.z) - (F.y - B.y),
    (F.x - B.x) - (R.z - L.z),
    (R.y - L.y) - (U.x - D.x));
  outColor = vec4(w, length(w));
}`;

// Empuxo (Boussinesq) + confinamento de vorticidade (Fedkiw, Stam & Jensen 2001) + vento.
export const forces = HEADER + `
uniform sampler2D uVel;
uniform sampler2D uScalar;
uniform sampler2D uCurl;
uniform float uDt;
uniform float uBuoyancy;  // alpha: ganho de empuxo pela temperatura
uniform float uWeight;    // beta: peso da fumaça (densidade)
uniform float uVorticity; // epsilon
uniform vec3 uWind;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  vec4 v = fetch(uVel, c);
  float dens = fetch(uScalar, c).a;

  float wL = fetch(uCurl, c - ivec3(1, 0, 0)).w;
  float wR = fetch(uCurl, c + ivec3(1, 0, 0)).w;
  float wD = fetch(uCurl, c - ivec3(0, 1, 0)).w;
  float wU = fetch(uCurl, c + ivec3(0, 1, 0)).w;
  float wB = fetch(uCurl, c - ivec3(0, 0, 1)).w;
  float wF = fetch(uCurl, c + ivec3(0, 0, 1)).w;
  vec3 eta = 0.5 * uInvH * vec3(wR - wL, wU - wD, wF - wB);
  vec3 Nv = eta / (length(eta) + 1e-5);
  vec3 omega = fetch(uCurl, c).xyz;
  vec3 f = uVorticity * uH * cross(Nv, omega);

  f.y += uBuoyancy * v.w - uWeight * dens;
  f += uWind;

  v.xyz += uDt * f;
  outColor = v;
}`;

// ---------------------------------------------------------------- projeção

// Velocidade de uma célula vizinha respeitando as fronteiras.
const NEIGHBOR_VEL = `
vec3 neighborVel(ivec3 n, vec3 vc) {
  int t = cellType(n);
  if (t == 0) return fetch(uVel, n).xyz;
  if (t == 2) return vc;              // saída: gradiente nulo
  if (inSphere(n)) return uSphereVel;  // obstáculo móvel
  return vec3(0.0);                    // parede
}
`;

export const divergence = HEADER + `
uniform sampler2D uVel;
` + NEIGHBOR_VEL + `
void main() {
  ivec3 c = voxel();
  if (c.z < 0 || inSphere(c)) { outColor = vec4(0.0); return; }
  vec3 vc = fetch(uVel, c).xyz;
  vec3 L = neighborVel(c - ivec3(1, 0, 0), vc);
  vec3 R = neighborVel(c + ivec3(1, 0, 0), vc);
  vec3 D = neighborVel(c - ivec3(0, 1, 0), vc);
  vec3 U = neighborVel(c + ivec3(0, 1, 0), vc);
  vec3 B = neighborVel(c - ivec3(0, 0, 1), vc);
  vec3 F = neighborVel(c + ivec3(0, 0, 1), vc);
  float div = 0.5 * uInvH * ((R.x - L.x) + (U.y - D.y) + (F.z - B.z));
  outColor = vec4(div, 0.0, 0.0, 0.0);
}`;

// Pressão nas fronteiras: Neumann (dp/dn = 0) em paredes, Dirichlet (p = 0) na saída.
const NEIGHBOR_P = `
float neighborP(ivec3 n, float pc) {
  int t = cellType(n);
  if (t == 0) return fetch(uPressure, n).x;
  if (t == 2) return 0.0;
  return pc;
}
`;

// Uma iteração de Jacobi para ∇²p = ∇·u.
export const jacobi = HEADER + `
uniform sampler2D uPressure;
uniform sampler2D uDiv;
` + NEIGHBOR_P + `
void main() {
  ivec3 c = voxel();
  if (c.z < 0 || inSphere(c)) { outColor = vec4(0.0); return; }
  float div = fetch(uDiv, c).x;

  float pc = fetch(uPressure, c).x;
  float sum = neighborP(c - ivec3(1, 0, 0), pc) + neighborP(c + ivec3(1, 0, 0), pc)
            + neighborP(c - ivec3(0, 1, 0), pc) + neighborP(c + ivec3(0, 1, 0), pc)
            + neighborP(c - ivec3(0, 0, 1), pc) + neighborP(c + ivec3(0, 0, 1), pc);
  outColor = vec4((sum - uH * uH * div) / 6.0, 0.0, 0.0, 0.0);
}`;

// u ← u − ∇p, depois impõe não-penetração em paredes e na esfera.
export const subtractGradient = HEADER + `
uniform sampler2D uVel;
uniform sampler2D uPressure;
` + NEIGHBOR_P + `
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  vec4 v = fetch(uVel, c);
  if (inSphere(c)) { outColor = vec4(uSphereVel, 0.0); return; }
  float pc = fetch(uPressure, c).x;
  vec3 grad = 0.5 * uInvH * vec3(
    neighborP(c + ivec3(1, 0, 0), pc) - neighborP(c - ivec3(1, 0, 0), pc),
    neighborP(c + ivec3(0, 1, 0), pc) - neighborP(c - ivec3(0, 1, 0), pc),
    neighborP(c + ivec3(0, 0, 1), pc) - neighborP(c - ivec3(0, 0, 1), pc));
  v.xyz -= grad;

  // Paredes: zera a componente normal que aponta para dentro da parede.
  if (c.x == 0) v.x = max(v.x, 0.0);
  if (c.x == uN.x - 1) v.x = min(v.x, 0.0);
  if (c.y == 0) v.y = max(v.y, 0.0);
  if (c.y == uN.y - 1 && uOpenTop == 0) v.y = min(v.y, 0.0);
  if (c.z == 0) v.z = max(v.z, 0.0);
  if (c.z == uN.z - 1) v.z = min(v.z, 0.0);

  // Esfera: deslizamento livre, sem atravessar a superfície (velocidade relativa).
  if (uSphere.w > 0.0) {
    vec3 d = worldPos(c) - uSphere.xyz;
    float dist = length(d);
    if (dist < uSphere.w + 1.5 * uH) {
      vec3 n = d / max(dist, 1e-5);
      vec3 rel = v.xyz - uSphereVel;
      float vn = dot(rel, n);
      if (vn < 0.0) v.xyz -= vn * n;
    }
  }
  outColor = v;
}`;

// Multiplica a pressão anterior (chute inicial do Jacobi no passo seguinte).
export const scale = HEADER + `
uniform sampler2D uSrc;
uniform float uScale;
void main() {
  ivec3 c = voxel();
  if (c.z < 0) { outColor = vec4(0.0); return; }
  outColor = fetch(uSrc, c) * uScale;
}`;

// ---------------------------------------------------------------- render

// Copia a grade para dois volumes 3D de renderização (MRT), com a parte cara
// da iluminação pré-calculada por célula:
//   volume A: rgb = albedo do corante, a = densidade;
//   volume B: r = transmitância até o sol (autossombra), g = transmitância até
//             o céu (oclusão ambiente), b = temperatura.
// Função de fase, emissão e cor final ficam no ray-marching, por pixel.
export const bakeVolume = HEADER + `
layout(location = 1) out vec4 outLight;
uniform sampler2D uScalar;
uniform sampler2D uVel;
uniform int uLayer;
uniform vec3 uLightDir;     // normalizada, aponta PARA a luz
uniform float uDensityScale;
uniform int uLightSteps;
uniform int uFireMode;

float marchDensity(vec3 p, vec3 dp, int steps) {
  float acc = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    p += dp;
    ivec3 q = ivec3(floor(p + 0.5));
    if (any(lessThan(q, ivec3(0))) || any(greaterThanEqual(q, uN))) break;
    acc += texelFetch(uScalar, atlasCoord(q), 0).a;
  }
  return acc;
}

void main() {
  ivec3 c = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  vec4 s = fetch(uScalar, c);
  float dens = s.a;
  // A correção de MacCormack limita cada canal separadamente, então cor/densidade
  // pode passar de 1 onde a densidade é minúscula: limitamos para não gerar pontos.
  vec3 albedo = dens > 1e-3 ? clamp(s.rgb / dens, 0.0, 1.0) : vec3(1.0);
  if (uFireMode == 1) albedo = vec3(0.32, 0.3, 0.29);
  float temp = fetch(uVel, c).w;

  // Começa meia célula à frente para a célula não sombrear a si mesma.
  float stepLen = 1.25;
  float accSun = 0.5 * s.a + marchDensity(vec3(c), uLightDir * stepLen, uLightSteps);
  float Tsun = exp(-uDensityScale * accSun * stepLen * uH);
  float accSky = marchDensity(vec3(c), vec3(0.0, 2.0, 0.0), uLightSteps / 3);
  float Tsky = exp(-uDensityScale * accSky * 2.0 * uH * 0.5);

  // Sombra da esfera sobre a fumaça.
  if (uSphere.w > 0.0) {
    vec3 o = worldPos(c) - uSphere.xyz;
    float b = dot(o, uLightDir);
    float cc = dot(o, o) - uSphere.w * uSphere.w;
    float h = b * b - cc;
    if (h > 0.0 && -b - sqrt(h) > 0.0) Tsun *= 0.12;
  }

  outColor = vec4(albedo, dens);
  outLight = vec4(Tsun, Tsky, temp, 0.0);
}`;
