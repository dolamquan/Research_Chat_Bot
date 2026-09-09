/** Code inserted into the isolated scene runtime, never into the 3D overview. */
export const SCIENTIFIC_HELPERS = String.raw`
function makeMatrix(values, opts = {}) {
  const rows=values.length, columns=Math.max(1,...values.map(row=>row.length));
  const cell=opts.cellSize || 0.65, width=columns*cell, height=rows*cell;
  const group=new THREE.Group();
  group.userData.cells=[];
  values.forEach((row,r)=>{
    const cells=[];
    row.forEach((value,c)=>{
      const text=typeof value==="number" ? value.toFixed(opts.decimals ?? 1) : String(value);
      const label=makeLabel(text,{size:0.32,color:opts.color || theme.ink,role:"value"});
      label.position.set((c-(columns-1)/2)*cell,((rows-1)/2-r)*cell,0.04);
      group.add(label);cells.push(label);
    });group.userData.cells.push(cells);
  });
  const points=[];
  for(const side of [-1,1]) {
    const x=side*(width/2+0.22),end=x-side*0.2;
    points.push(new THREE.Vector3(end,height/2+0.12,0),new THREE.Vector3(x,height/2+0.12,0),
      new THREE.Vector3(x,height/2+0.12,0),new THREE.Vector3(x,-height/2-0.12,0),
      new THREE.Vector3(x,-height/2-0.12,0),new THREE.Vector3(end,-height/2-0.12,0));
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:opts.color || theme.muted,transparent:true,opacity:0.8})));
  if(opts.title) {
    const title=makeLabel(opts.title,{size:0.7,role:"heading"});title.position.set(0,height/2+0.85,0);group.add(title);
  }
  return group;
}

function makeNetwork(layerSizes, opts = {}) {
  const group=new THREE.Group(),width=opts.width || 5,height=opts.height || 4;
  const layers=[],points=[],colors=[];
  const sphere=new THREE.SphereGeometry(0.07,12,8);
  layerSizes.forEach((count,l)=>{
    const nodes=[];
    for(let n=0;n<count;n++) {
      const node=new THREE.Mesh(sphere,new THREE.MeshBasicMaterial({color:theme.ink}));
      node.position.set((l/Math.max(1,layerSizes.length-1)-0.5)*width,(0.5-n/Math.max(1,count-1))*height,count===1?0:Math.sin(n)*0.1);
      if(count===1) node.position.y=0;
      group.add(node);nodes.push(node);
    }layers.push(nodes);
  });
  for(let l=1;l<layers.length;l++) for(let to=0;to<layers[l].length;to++) for(let from=0;from<layers[l-1].length;from++) {
    const weight=opts.weights?.[l-1]?.[to]?.[from];
    const color=new THREE.Color(weight===undefined ? theme.muted : weight<0 ? theme.danger : theme.data);
    color.multiplyScalar(weight===undefined ? 0.28 : 0.2+Math.min(1,Math.abs(weight))*0.6);
    points.push(layers[l-1][from].position,layers[l][to].position);colors.push(...color.toArray(),...color.toArray());
  }
  const geometry=new THREE.BufferGeometry().setFromPoints(points);
  geometry.setAttribute("color",new THREE.Float32BufferAttribute(colors,3));
  group.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:0.7})));
  group.userData.layers=layers;
  if(opts.title) {const title=makeLabel(opts.title,{size:0.8,role:"heading"});title.position.set(0,height/2+0.9,0);group.add(title);}
  return group;
}
`;
