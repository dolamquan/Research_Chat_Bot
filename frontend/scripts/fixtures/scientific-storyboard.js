// An illustrative calculation, not a saved paper or a trained model's weights.
const state = {};
function init(ctx) {
  const weights=[[0.5,-0.2,0.7],[-0.4,0.8,0.1],[0.6,0.2,-0.5]];
  state.input=ctx.makeMatrix([[0.8],[-0.3],[0.5]],{title:'Input x',decimals:2,color:ctx.theme.data});
  state.weights=ctx.makeMatrix(weights,{title:'Weights W',decimals:2,cellSize:0.9});
  state.network=ctx.makeNetwork([3,3],{title:'Weighted connections',width:3.5,height:2.8,weights:[weights]});
  state.result=ctx.makeMatrix([[0.81],[0],[0.17]],{title:'ReLU(Wx)',decimals:2,color:ctx.theme.output});
  state.input.position.set(-7,0,0);
  state.weights.position.set(-3.7,0,-0.7);
  state.network.position.set(1.6,0,0.3);
  state.result.position.set(6.3,0,0);
  ctx.scene.add(state.input,state.weights,state.network,state.result);
  const note=ctx.makeLabel('Illustrative weights and values',{size:0.35,color:ctx.theme.muted});
  note.position.set(0,-3.2,0);ctx.scene.add(note);
  ctx.camera.position.set(3,2.2,24);ctx.controls.target.set(0,0,0);
}
function update(ctx,t) {
  const phase=Math.floor((t%12)/4);
  state.weights.visible=phase>=1;state.network.visible=phase>=1;state.result.visible=phase>=2;
  state.network.userData.layers[1].forEach((node,i)=>{
    node.material.color.set(Math.floor(t*1.5)%3===i?ctx.theme.data:ctx.theme.ink);
  });
  ctx.setCaption([
    '01  Start with a vector: three input features.',
    '02  Multiply by W. Teal connections are positive; coral connections are negative.',
    '03  Wx = [0.81, -0.51, 0.17]. ReLU replaces the negative value with zero.'
  ][phase]);
}
