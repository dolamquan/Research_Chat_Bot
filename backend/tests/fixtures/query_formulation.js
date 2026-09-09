// Illustrative QFS example; these scores are examples, not measurements from a model.
const state = {};
function init(ctx) {
  const tokens = ['earth', 'Mars', 'orbit', 'gravity', 'mission'];
  const scores = [1.1, 0.3, 0.9, 0.6, 0.05];
  const sum = scores.reduce((total, score) => total + Math.exp(score), 0);
  const weights = scores.map(score => Math.exp(score) / sum);
  const selected = [0, 2, 3];
  const colors = ['#85a3bd', '#cf9f45', '#86b380'];
  state.panels = ['01  Context tokens', '02  Attention weights', '03  Retrieval query'].map((title, i) => {
    const panel = ctx.makePanel(title, {width:4.6, height:5.8, color:colors[i]});
    ctx.scene.add(panel);
    return panel;
  });
  function label(parent, text, x, y, color = '#cfcfcf', size = 0.42) {
    const item = ctx.makeLabel(text, {size, color, background:'transparent'});
    item.position.set(x, y, 0.15); parent.add(item); return item;
  }
  label(state.panels[0], 'Earlier context + current token', 0, 1.85, '#969696', 0.36);
  label(state.panels[1], 'Illustrative softmax scores', 0, 1.85, '#969696', 0.36);
  label(state.panels[2], 'Top 3 earlier tokens, in order', 0, 1.85, '#969696', 0.36);
  state.bars = [];
  tokens.forEach((token, i) => {
    const y = 1.05 - i * 0.62;
    label(state.panels[0], token + (i === 4 ? '  (current)' : ''), 0, y, i === 4 ? '#969696' : '#f5f5f5');
    const bar = new ctx.THREE.Mesh(new ctx.THREE.PlaneGeometry(weights[i] * 5, 0.2),
      new ctx.THREE.MeshBasicMaterial({color:colors[1], transparent:true, opacity:0.45}));
    bar.position.set(-1.55 + weights[i] * 2.5, y, 0.1);
    state.panels[1].add(bar); state.bars.push(bar);
    label(state.panels[1], weights[i].toFixed(2), 1.4, y);
  });
  state.outputs = selected.map((index, i) => label(state.panels[2], tokens[index], 0, 1.05 - i * 0.62, colors[2]));
  label(state.panels[0], 'Target token: mission', 0, -2.3, '#969696', 0.38);
  label(state.panels[1], 'Select among earlier tokens', 0, -2.3, '#969696', 0.38);
  label(state.panels[2], 'earth orbit gravity', 0, -1.55, '#f5f5f5', 0.48);
  label(state.panels[2], 'Send query to the retriever', 0, -2.3, '#969696', 0.38);
  state.title = label(ctx.scene, 'Query formulation with self-attention', 0, 3.65, '#f5f5f5', 0.65);
  state.arrows = [-2.7, 2.7].map(x => label(ctx.scene, '→', x, 0, '#969696', 0.55));
  state.phase = -1;
  ctx.camera.position.set(0,0,18); ctx.controls.target.set(0,0,0);
}
function resize(ctx) {
  const narrow = ctx.width < 760;
  ctx.setContentHeight(narrow ? 1800 : ctx.height);
  state.panels.forEach((panel,i) => panel.position.set(narrow ? 0 : (i-1)*5.4, narrow ? (1-i)*6.9 : 0, 0));
  state.title.position.set(0, narrow ? 10.9 : 3.65, 0);
  state.arrows.forEach((arrow,i) => {
    arrow.position.set(narrow ? 0 : (i ? 2.7 : -2.7), narrow ? (i ? -3.45 : 3.45) : 0, 0.2);
    arrow.material.rotation = narrow ? -Math.PI/2 : 0;
  });
}
function update(ctx,t) {
  const phase = Math.floor((t % 12) / 4);
  if (phase !== state.phase) {
    state.phase = phase;
    ctx.setCaption([
      '1 / 3  Read the preceding context. “mission” is the current token in this example.',
      '2 / 3  Rank earlier tokens using attention weights. Select earth, orbit, and gravity.',
      '3 / 3  Preserve the selected tokens’ original order to form the retrieval query.',
    ][phase]);
  }
  state.bars.forEach(bar => {bar.material.opacity = phase >= 1 ? 0.9 : 0.45;});
  state.outputs.forEach(output => {output.material.opacity = phase === 2 ? 1 : 0.8;});
}
