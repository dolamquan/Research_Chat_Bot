// A small worked example: statistics across features of ONE token.
const state = {};
function init(ctx) {
  const { THREE } = ctx;
  const input = [1, 0.5, 0.2, -0.3, 0.9, 0];
  const mean = input.reduce((sum, x) => sum + x, 0) / input.length;
  const variance = input.reduce((sum, x) => sum + (x - mean) ** 2, 0) / input.length;
  const normalized = input.map(x => (x - mean) / Math.sqrt(variance + 1e-5));
  const gamma = [1.2, 1, 0.8, 1.1, 0.9, 1.2];
  const beta = [0.1, 0, -0.1, 0.1, 0, -0.1];
  const output = normalized.map((x, i) => gamma[i] * x + beta[i]);
  state.panels = [];
  state.bars = [];
  const colors = ['#85a3bd', '#cf9f45', '#86b380'];
  const titles = ['01  Input features', '02  Center & normalize', '03  Scale & shift'];
  const notes = ['One token · six features', 'Mean 0 · variance ≈ 1', 'Learned γ and β per feature'];
  [input, normalized, output].forEach((values, i) => {
    const panel = ctx.makePanel(titles[i], {width: 4.5, height: 5.4, color: colors[i]});
    panel.position.set((i - 1) * 5.3, 0, 0);
    ctx.scene.add(panel);
    state.panels.push(panel);
    const note = ctx.makeLabel(notes[i], {size: 0.4, background: 'transparent'});
    note.position.set(0, 1.45, 0.1);
    panel.add(note);
    const bars = ctx.makeBars(values, {width: 3.8, height: 1.2, maxValue: 2, color: colors[i]});
    bars.position.y = -0.05;
    panel.add(bars);
    state.bars.push(bars);
    const formula = ctx.makeLabel(i === 0 ? 'μ = ' + mean.toFixed(2) + '  ·  σ² = ' + variance.toFixed(2)
      : i === 1 ? '(x − μ) / √(σ² + ε)' : 'y = γ ⊙ x̂ + β', {size: 0.42, color: colors[i], background: 'transparent'});
    formula.position.set(0, -2.15, 0.1);
    panel.add(formula);
  });
  const title = ctx.makeLabel('Layer normalization', {size: 0.7, background: 'transparent'});
  title.position.set(0, 3.6, 0);
  ctx.scene.add(title);
  state.title = title;
  const subtitle = ctx.makeLabel('Per token · across features', {size: 0.42, background: 'transparent'});
  subtitle.position.set(0, -3.5, 0);
  ctx.scene.add(subtitle);
  state.subtitle = subtitle;
  state.pulses = [];
  [-2.65, 2.65].forEach(x => {
    const arrow = ctx.makeLabel('→', {size: 0.55, color: '#969696', background: 'transparent'});
    arrow.position.set(x, 0.3, 0.2);
    ctx.scene.add(arrow);
    state.pulses.push(arrow);
  });
  state.phase = -1;
  state.captions = [
    '1 / 3  Read six features of one token. Compute their mean and variance.',
    '2 / 3  Subtract the mean, then divide by √(variance + ε) for stability.',
    '3 / 3  Apply learned scale γ and shift β to each feature. Pass the result to the next stage.',
  ];
  ctx.camera.position.set(0, 0, 17);
  ctx.controls.target.set(0, 0, 0);
}
function resize(ctx) {
  const narrow = ctx.width < 760;
  ctx.setContentHeight(narrow ? 1700 : ctx.height);
  state.panels.forEach((panel, i) => panel.position.set(narrow ? 0 : (i - 1) * 5.3, narrow ? (1 - i) * 6.4 : 0, 0));
  state.title.position.set(0, narrow ? 10.2 : 3.6, 0);
  state.subtitle.position.set(0, narrow ? -10.2 : -3.5, 0);
  state.pulses.forEach((arrow, i) => {
    arrow.position.set(narrow ? 0 : (i ? 2.65 : -2.65), narrow ? (i ? -3.2 : 3.2) : 0.3, 0.2);
    arrow.material.rotation = narrow ? -Math.PI / 2 : 0;
  });
}
function update(ctx, t) {
  const phase = Math.floor((t % 12) / 4);
  if (phase !== state.phase) {
    state.phase = phase;
    ctx.setCaption(state.captions[phase]);
  }
  state.panels.forEach((panel, i) => {
    const scale = i === phase ? 1.025 : 1;
    panel.scale.set(scale, scale, 1);
  });
  state.pulses.forEach((arrow, i) => {
    arrow.material.opacity = phase === i + 1 ? 0.75 + Math.sin(t * 3) * 0.25 : 0.45;
  });
}
