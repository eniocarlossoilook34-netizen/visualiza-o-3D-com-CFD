// Ray-marching do volume de fumaça. Cada pixel lança um raio da câmera,
// intersecta a caixa da simulação e acumula radiância de frente para trás:
//   alpha_i = 1 − exp(−σ_i Δs),   C += T·alpha_i·L_i,   T *= 1 − alpha_i.
//
// L_i combina luz do sol (autossombra pré-calculada × função de fase de
// Henyey–Greenstein em dois lóbulos), luz do céu (com oclusão) e emissão por
// temperatura. Um ruído 3D erode as bordas da fumaça para dar detalhe abaixo
// da resolução da grade. O fundo (céu, chão e esfera) é desenhado aqui também.

export const raymarch = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 outColor;

uniform sampler3D uVolA;     // rgb = albedo, a = densidade
uniform sampler3D uVolB;     // r = transmitância ao sol, g = ao céu, b = temperatura
uniform sampler3D uNoise;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uBox;
uniform vec4 uSphere;
uniform vec3 uSphereColor;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uSkyColor;
uniform float uDensityScale;
uniform float uStep;
uniform float uTime;
uniform float uExposure;
uniform int uShowBox;
uniform int uFireMode;
uniform float uEmission;
uniform float uDetail;       // intensidade da erosão por ruído (0 = desligado)
uniform float uDetailScale;  // frequência do ruído (ciclos por unidade de mundo)
uniform vec4 uGlow;          // xyz = posição da fonte de luz do fogo, w = intensidade

const float PI = 3.14159265;

vec2 hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

float hitSphere(vec3 ro, vec3 rd, vec4 s) {
  if (s.w <= 0.0) return 1e9;
  vec3 o = ro - s.xyz;
  float b = dot(o, rd);
  float c = dot(o, o) - s.w * s.w;
  float h = b * b - c;
  if (h < 0.0) return 1e9;
  float t = -b - sqrt(h);
  return t > 0.0 ? t : 1e9;
}

// Ruído de gradiente intercalado (Jimenez 2014): dithering do início do raio.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float hg(float cosT, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
}

// Dois lóbulos: espalhamento para frente (borda prateada contra a luz) e um
// pouco para trás. Multiplicado por 4π para ter média 1.
float phase(float cosT) {
  return 4.0 * PI * mix(hg(cosT, 0.6), hg(cosT, -0.25), 0.35);
}

vec3 blackbody(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = vec3(1.0, 0.22, 0.03) * smoothstep(0.0, 0.3, t);
  c = mix(c, vec3(1.0, 0.55, 0.12), smoothstep(0.25, 0.6, t));
  c = mix(c, vec3(1.0, 0.92, 0.7), smoothstep(0.6, 1.0, t));
  return c * (0.25 + 4.0 * t * t);
}

float boxEdge(vec3 p, float t) {
  vec3 q = min(p, uBox - p);
  vec3 s = step(q, vec3(0.0022 * t));
  return (s.x + s.y + s.z) >= 2.0 ? 1.0 : 0.0;
}

bool inBox(vec3 p) {
  return all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, uBox));
}

// Transmitância ao sol num ponto qualquer: dentro da caixa lê o volume B;
// fora, procura onde o raio de luz entra na caixa e lê ali.
float sunTransmittance(vec3 p) {
  if (inBox(p)) return texture(uVolB, p / uBox).r;
  vec2 tb = hitBox(p, uLightDir, vec3(0.0), uBox);
  if (tb.x < tb.y && tb.y > 0.0) {
    vec3 q = p + uLightDir * (max(tb.x, 0.0) + 0.01);
    return texture(uVolB, clamp(q / uBox, 0.0, 1.0)).r;
  }
  return 1.0;
}

vec3 fireGlow(vec3 p, vec3 n) {
  if (uGlow.w <= 0.0) return vec3(0.0);
  vec3 d = uGlow.xyz - p;
  float r2 = dot(d, d);
  float lam = max(dot(n, normalize(d)), 0.0);
  return vec3(1.0, 0.45, 0.12) * uGlow.w * lam / (1.0 + 18.0 * r2);
}

vec3 background(vec3 ro, vec3 rd) {
  vec3 skyCol = mix(vec3(0.06, 0.065, 0.08), vec3(0.012, 0.014, 0.02), clamp(rd.y * 0.5 + 0.5, 0.0, 1.0));
  if (rd.y < -1e-4) {
    float t = -ro.y / rd.y;
    vec3 p = ro + rd * t;
    vec2 g = abs(fract(p.xz * 4.0) - 0.5);
    float line = 1.0 - smoothstep(0.0, 0.03 * (1.0 + t * 0.4), min(g.x, g.y));
    vec2 g2 = abs(fract(p.xz) - 0.5);
    float major = 1.0 - smoothstep(0.0, 0.012 * (1.0 + t * 0.4), min(g2.x, g2.y));
    float fade = exp(-0.12 * t * t);
    vec3 albedo = vec3(0.07, 0.075, 0.09) + vec3(0.06, 0.07, 0.09) * line + vec3(0.07, 0.09, 0.12) * major;

    float sun = max(uLightDir.y, 0.0) * sunTransmittance(p + vec3(0.0, 0.002, 0.0));
    if (uSphere.w > 0.0) {
      vec3 toS = uSphere.xyz - p;
      float along = max(dot(toS, uLightDir), 0.0);
      float d = length(toS - along * uLightDir);
      sun *= mix(0.25, 1.0, smoothstep(uSphere.w * 0.7, uSphere.w * 1.4, d));
    }
    // Oclusão do céu sob a fumaça.
    float occ = 1.0;
    vec3 under = vec3(p.x, uBox.y * 0.04, p.z);
    if (inBox(under)) occ = mix(0.45, 1.0, texture(uVolB, under / uBox).g);
    vec3 lit = albedo * (uLightColor * sun * 0.55 + uSkyColor * occ * 0.6) + albedo * fireGlow(p, vec3(0.0, 1.0, 0.0)) * 4.0;
    return mix(skyCol, lit, fade);
  }
  return skyCol;
}

vec3 shadeSphere(vec3 p, vec3 rd) {
  vec3 n = normalize(p - uSphere.xyz);
  float diff = max(dot(n, uLightDir), 0.0) * sunTransmittance(p + n * 0.01);
  float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
  vec3 h = normalize(uLightDir - rd);
  float spec = pow(max(dot(n, h), 0.0), 60.0) * diff;
  float sky = 0.5 + 0.5 * n.y;
  return uSphereColor * (uLightColor * diff * 0.6 + uSkyColor * sky * 0.8 + fireGlow(p, n) * 2.0)
       + uLightColor * spec * 0.35 + vec3(0.2, 0.28, 0.4) * rim * 0.6;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  vec3 ro = uCamPos;
  vec3 rd = normalize(w.xyz / w.w - ro);

  float tS = hitSphere(ro, rd, uSphere);
  vec3 bg = tS < 1e8 ? shadeSphere(ro + rd * tS, rd) : background(ro, rd);

  vec2 tb = hitBox(ro, rd, vec3(0.0), uBox);
  vec3 col = vec3(0.0);
  float T = 1.0;

  if (tb.x < tb.y && tb.y > 0.0) {
    float t0 = max(tb.x, 0.0);
    float t1 = min(tb.y, tS);

    if (uShowBox == 1 && tS > tb.y) bg = mix(bg, vec3(0.35, 0.45, 0.6), 0.3 * boxEdge(ro + rd * tb.y, tb.y));

    float ph = phase(dot(rd, uLightDir));
    vec3 scroll = vec3(0.0, -uTime * 0.12, uTime * 0.03);

    float t = t0 + uStep * ign(gl_FragCoord.xy);
    for (int i = 0; i < 1024; i++) {
      if (t >= t1 || T < 0.005) break;
      vec3 p = ro + rd * t;
      vec3 uvw = p / uBox;
      vec4 A = texture(uVolA, uvw);
      float sigma = A.a * uDensityScale;
      if (sigma > 0.02) {
        vec4 B = texture(uVolB, uvw);
        // Erosão por ruído (estilo nuvens volumétricas): a cobertura local
        // c = 1 − e^(−kσ) é remapeada contra o ruído, o que recorta as bordas
        // finas e preserva o miolo denso.
        if (uDetail > 0.0) {
          float n = texture(uNoise, p * uDetailScale + scroll).r;
          float cov = 1.0 - exp(-sigma * 0.12);
          float cut = uDetail * 0.75 * (1.0 - n);
          float c2 = clamp((cov - cut) / max(1.0 - cut, 0.05), 0.0, 1.0);
          sigma *= c2 / max(cov, 1e-3);
        }
        // Sol: fase × autossombra, mais um termo suave que imita espalhamento múltiplo.
        vec3 sun = uLightColor * (B.r * ph + 0.12 * pow(B.r, 0.3));
        vec3 sky = uSkyColor * (0.1 + 0.9 * B.g);
        vec3 L = A.rgb * (sun + sky);
        if (uFireMode == 1) L += blackbody(B.b * 0.11) * uEmission;
        float a = 1.0 - exp(-sigma * uStep);
        col += T * a * L;
        T *= 1.0 - a;
      }
      t += uStep;
    }
  }

  vec3 c = col + T * bg;

  if (uShowBox == 1 && tb.x > 0.0 && tb.x < tb.y && tb.x < tS) {
    c = mix(c, vec3(0.45, 0.6, 0.8), 0.35 * boxEdge(ro + rd * tb.x, tb.x));
  }

  // Vinheta leve, tone mapping ACES e gama.
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.35 * dot(q, q);
  c = aces(c * uExposure);
  c = pow(c, vec3(1.0 / 2.2));
  outColor = vec4(c, 1.0);
}`;
