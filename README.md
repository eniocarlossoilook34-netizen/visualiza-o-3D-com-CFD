# Fumaça 3D interativa na GPU

Um solver de Navier–Stokes incompressível em 3D que roda **inteiro na placa de vídeo, dentro do navegador**,
com fumaça renderizada por *ray-marching* volumétrico. Você pinta fumaça com o mouse, arrasta um obstáculo
esférico pelo escoamento, dispara anéis de vórtice e acende uma fogueira, tudo em tempo real.

Sem dependências e sem etapa de build: HTML + JavaScript (ES modules) + GLSL (WebGL2).

```
        luz ☀  ↘
   ┌──────────────────┐   ← topo aberto (saída, p = 0)
   │    ░░▒▒▓▓▒▒░░    │
   │      ▒▓██▓▒      │   corante + temperatura advectados
   │        (●)  ←────┼── esfera móvel (condição de contorno)
   │        ▒▓▒       │
   │        ▓█▓  ↑    │   empuxo de Boussinesq
   │      ═══════     │   ← emissor
   └──────────────────┘   paredes: não-penetração
```

---

## Como rodar

ES modules não carregam via `file://`, então sirva a pasta com qualquer servidor estático:

```bash
python -m http.server 8022
```

Depois abra <http://localhost:8022>. Precisa de um navegador com **WebGL2** e da extensão
`EXT_color_buffer_float` (Chrome, Edge e Firefox em desktop têm as duas).

### Controles

| Entrada | Ação |
|---|---|
| Arrastar com o botão esquerdo | Pinta fumaça e empurra o fluido na direção do arrasto |
| Arrastar a esfera | Move o obstáculo (a velocidade dele entra na condição de contorno) |
| Botão direito, ou Shift + arrastar | Gira a câmera |
| Roda do mouse | Zoom |
| `R` | Dispara um anel de vórtice na direção da câmera |
| `E` | Explosão no ponto do mouse |
| `Espaço` / `C` | Pausa / limpa |
| `B` / `F` | Liga/desliga a esfera / modo fogo |
| `1`–`5` | Presets: Chaminé, Fogueira, Anéis de fumaça, Vento lateral, Tela livre |
| `H` | Esconde o painel |

---

## 1. A física

O ar é tratado como fluido **incompressível** e **invíscido** (a viscosidade numérica da advecção já
dissipa mais que a física dissiparia nessas escalas):

$$
\frac{\partial \mathbf u}{\partial t} + (\mathbf u\cdot\nabla)\mathbf u = -\frac{1}{\rho}\nabla p + \mathbf f,
\qquad \nabla\cdot\mathbf u = 0
$$

Junto da velocidade são transportados dois escalares passivos (ou quase): a **densidade de fumaça**
$\rho_s$ (com a cor do corante) e a **temperatura** $T$:

$$
\frac{\partial \phi}{\partial t} + (\mathbf u\cdot\nabla)\phi = -k_\phi\,\phi + S_\phi
$$

onde $k_\phi$ é uma taxa de dissipação/resfriamento e $S_\phi$ são as fontes (emissor e mouse).

### Forças de corpo

**Empuxo de Boussinesq.** O ar quente sobe e a fumaça pesada desce:

$$
\mathbf f_\text{emp} = \left(\alpha\,T - \beta\,\rho_s\right)\hat{\mathbf y}
$$

**Confinamento de vorticidade** (Fedkiw, Stam & Jensen, 2001). A advecção semi-Lagrangiana é muito
difusiva e apaga os redemoinhos pequenos. Essa força recoloca, de forma controlada, a rotação perdida:

$$
\boldsymbol\omega = \nabla\times\mathbf u,\qquad
\mathbf N = \frac{\nabla|\boldsymbol\omega|}{\lVert\nabla|\boldsymbol\omega|\rVert},\qquad
\mathbf f_\text{conf} = \varepsilon\, h\,(\mathbf N\times\boldsymbol\omega)
$$

É o controle "Confinamento de vorticidade" do painel: com 0 a fumaça fica lisa e "borrachuda", e
valores altos dão turbulência fina (até instabilizar).

---

## 2. O método numérico: *Stable Fluids*

Divisão de operadores (Stam, 1999). Cada passo $\Delta t$:

1. **Advecção** da velocidade e da temperatura: semi-Lagrangiana (traça a partícula para trás,
   $\mathbf x - \Delta t\,\mathbf u$, e interpola trilinearmente). É incondicionalmente estável, ou
   seja, não tem limite de CFL.
2. **Advecção do corante com MacCormack** (Selle et al., 2008): um passo para frente, um para trás,
   e a correção $\phi^{n+1} = \hat\phi + \tfrac12(\phi^n - \bar\phi)$, limitada ao intervalo dos
   vizinhos para não criar oscilações. Dá 2ª ordem e uma fumaça bem mais nítida.
3. **Fontes**: emissor, pincel, anéis e explosões (*splats* gaussianos).
4. **Forças**: empuxo + confinamento de vorticidade + vento.
5. **Projeção de pressão**: resolve a equação de Poisson
   $$\nabla^2 \tilde p = \nabla\cdot\mathbf u^*,\qquad \tilde p = \frac{\Delta t}{\rho}\,p$$
   com iterações de **Jacobi** (cada célula vira a média dos vizinhos menos o termo fonte), usando a
   pressão do passo anterior como chute inicial, e depois $\mathbf u = \mathbf u^* - \nabla \tilde p$.
   O resultado é um campo de divergência (quase) nula. ($\Delta t/\rho$ fica embutido em $\tilde p$.)

### Condições de contorno

| Fronteira | Velocidade | Pressão |
|---|---|---|
| Paredes laterais e fundo | não-penetração ($\mathbf u\cdot\hat{\mathbf n} = 0$) | Neumann, $\partial p/\partial n = 0$ |
| Topo (opcional) | saída livre | Dirichlet, $p = 0$ |
| Esfera móvel | $\mathbf u\cdot\hat{\mathbf n} = \mathbf u_\text{esf}\cdot\hat{\mathbf n}$ (deslizamento livre) | Neumann |

A esfera empurra o fluido quando você a arrasta porque a velocidade dela entra na divergência das
células vizinhas, e o solver de pressão faz o resto.

### Discretização

Grade colocalizada (todas as variáveis no centro da célula), diferenças centrais para divergência,
gradiente e rotacional. É mais simples que a grade deslocada (MAC) e funciona bem para efeitos
visuais; o preço é um leve modo "tabuleiro de xadrez" na pressão, que a advecção amortece.

---

## 3. Como roda na GPU

WebGL2 não tem compute shaders, então **cada passo é um fragment shader** desenhado sobre um quadrado
que cobre a textura: um pixel corresponde a uma célula.

**Grade 3D num atlas 2D.** As fatias $z$ da grade $n_x\times n_y\times n_z$ ficam lado a lado numa
textura 2D. Isso permite renderizar todos os campos de uma vez (WebGL2 não renderiza num volume 3D
inteiro numa só chamada). A interpolação trilinear é feita à mão com 8 `texelFetch`.

```
 atlas (64×96×64 → 8×8 ladrilhos = 512×768 texels)
 ┌────┬────┬────┬─ ─ ┬────┐
 │z=56│z=57│z=58│    │z=63│
 ├────┼────┼────┼─ ─ ┼────┤
 │ …  │    │    │    │    │
 ├────┼────┼────┼─ ─ ┼────┤
 │z=0 │z=1 │z=2 │    │z=7 │
 └────┴────┴────┴─ ─ ┴────┘
```

**Formatos de textura escolhidos pela banda.** Numa GPU integrada o gargalo é a banda de memória, não
a aritmética. Velocidade e corante ficam em `RGBA16F`, pressão e divergência em `R32F` (um canal). Só
isso cortou o tempo do passo pela metade (28 → 14 ms numa Intel UHD, grade 64×96×64).

**Renderização.** A cada quadro a grade é copiada para **dois volumes 3D** (`RGBA16F`, com filtragem
trilinear por hardware), com a parte cara da iluminação já calculada por célula:

- volume A: cor do corante e densidade;
- volume B: transmitância até o sol (autossombra), transmitância até o céu (oclusão) e temperatura.

Depois, um raio por pixel atravessa a caixa acumulando de frente para trás:

$$
\alpha_i = 1 - e^{-\sigma_i \Delta s},\qquad C \mathrel{+}= T\,\alpha_i\,L_i,\qquad T \mathrel{*}= 1-\alpha_i
$$

$$
L_i = \text{albedo}\,\big[\,L_\odot\,(T_\odot\,p(\cos\theta) + 0{,}12\,T_\odot^{0,3}) + L_\text{céu}\,T_\text{céu}\big] + E(T)
$$

- $p(\cos\theta)$ é a **função de fase de Henyey–Greenstein** com dois lóbulos: olhando contra a luz, a
  borda da fumaça fica prateada (espalhamento para frente).
- O termo $T_\odot^{0,3}$ imita o espalhamento múltiplo, que clareia o miolo da fumaça.
- $E(T)$ é a emissão de corpo negro aproximada no **modo fogo**.
- **Detalhe abaixo da resolução da grade:** um ruído fBm 3D (32³, com mipmaps) erode as bordas finas da
  fumaça, como em nuvens volumétricas de jogos. A grade de 64 células ganha filetes que ela sozinha não
  resolveria, sem custo nenhum na simulação. É só visual, não muda a física.
- O chão e a esfera recebem a **sombra da fumaça** (lendo a transmitância ao sol do volume B).
- **Resolução dinâmica:** a escala de renderização se ajusta sozinha para manter ~45 FPS.

Uma lição de desempenho: a primeira versão do ruído usava uma textura 64³ em frequência alta, o que
deixou o ray-marching **6× mais lento** por falta de cache. Com 32³ + mipmaps o custo virou ruído.

### Desempenho medido (Intel UHD Graphics, integrada)

| Grade | Células | Passo + iluminação |
|---|---|---|
| 48×72×48 | 0,17 M | 11 ms |
| 64×96×64 (padrão) | 0,39 M | 17 ms |
| 80×120×80 | 0,77 M | 32 ms |
| 96×144×96 | 1,33 M | 60 ms |
| 128×192×128 | 3,15 M | 150 ms |

Uma GPU dedicada deve rodar a grade "Muito alta" em tempo real. O ray-marching é ajustável pelo
controle "Escala de renderização".

---

## 4. Estrutura

```
index.html, style.css
src/
  main.js          loop, entrada (mouse/teclado), presets
  fluid.js         classe Fluid3D: texturas e a sequência de passos
  camera.js        câmera orbital, matrizes, picking por raio
  gl.js            programas, alvos de renderização, volume 3D
  ui.js            painel de controles (sem dependências)
  shaders/
    fluid.js       advecção, MacCormack, splats, forças, divergência, Jacobi, projeção, bake
    render.js      ray-marching, chão, esfera, tone mapping
```

### Parâmetros de URL

Úteis para links e capturas de tela de portfólio:

| Parâmetro | Exemplo | Efeito |
|---|---|---|
| `preset` | `?preset=Fogueira` | Abre num preset |
| `grade` | `&grade=Alta` | Resolução da grade (prefixo do nome) |
| `warmup` | `&warmup=5` | Simula N segundos antes do 1º quadro |
| `ui` | `&ui=0` | Esconde o painel |
| `yaw`, `pitch`, `dist` | `&dist=2.4` | Posição da câmera |

No console do navegador, `app` expõe o estado e `await app.advance(120)` avança 2 s de simulação.
Os dois rodam em lotes pequenos: enfileirar segundos de trabalho de GPU de uma vez dispara o watchdog
do driver, e o navegador desliga o WebGL até ser reiniciado.

---

## 5. Próximos passos

- **Modo SPH** (partículas): água com superfície livre, para comparar Euler × Lagrange no mesmo app.
- **Multigrid** no lugar de Jacobi: converge em O(n) e permite grades bem maiores.
- **Grade MAC deslocada** para eliminar o modo tabuleiro da pressão.
- **WebGPU** com compute shaders (sem atlas e sem os truques de fragment shader).
- **Validação**: número de Strouhal da esteira atrás da esfera contra a literatura (St ≈ 0,2), ligando
  com o caso do cilindro do projeto 21.

## Referências

- J. Stam, *Stable Fluids*, SIGGRAPH 1999.
- R. Fedkiw, J. Stam, H. W. Jensen, *Visual Simulation of Smoke*, SIGGRAPH 2001.
- A. Selle, R. Fedkiw, B. Kim, Y. Liu, J. Rossignac, *An Unconditionally Stable MacCormack Method*, J. Sci. Comput., 2008.
- M. Harris, *Fast Fluid Dynamics Simulation on the GPU*, GPU Gems, cap. 38, 2004.
- K. Crane, I. Llamas, S. Tariq, *Real-Time Simulation and Rendering of 3D Fluids*, GPU Gems 3, cap. 30, 2007.
- R. Bridson, *Fluid Simulation for Computer Graphics*, 2ª ed., CRC Press, 2015.
