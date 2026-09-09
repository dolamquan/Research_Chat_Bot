import {describe,expect,it} from 'vitest';
import * as THREE from 'three';
import {SCIENTIFIC_HELPERS} from '../scientificHelpers';
import {SCENE_THEME} from '../sceneRuntime';

function helpers() {
  const makeLabel=(text:string) => {
    const sprite=new THREE.Sprite(new THREE.SpriteMaterial());
    sprite.userData.text=text;return sprite;
  };
  return new Function('THREE','theme','makeLabel',SCIENTIFIC_HELPERS+';return {makeMatrix,makeNetwork};')(THREE,SCENE_THEME,makeLabel);
}

describe('scientific scene primitives',()=>{
  it('preserves matrix values and separates rows/columns within brackets',()=>{
    const matrix=helpers().makeMatrix([[0.81,-0.51],[0.17,0]],{decimals:2,cellSize:0.8});
    const cells=matrix.userData.cells;
    expect(cells.map((row:THREE.Sprite[])=>row.map(c=>c.userData.text))).toEqual([['0.81','-0.51'],['0.17','0.00']]);
    expect(cells[0][1].position.x-cells[0][0].position.x).toBeCloseTo(0.8);
    expect(cells[0][0].position.y-cells[1][0].position.y).toBeCloseTo(0.8);
    const bracket=matrix.children.find((child:THREE.Object3D)=>child instanceof THREE.LineSegments) as THREE.LineSegments;
    expect(bracket.geometry.getAttribute('position').count).toBe(12);
  });

  it('connects each supplied source/destination once with signed weight colors',()=>{
    const network=helpers().makeNetwork([2,2],{weights:[[[1,-1],[0.5,-0.5]]]});
    expect(network.userData.layers.map((layer:THREE.Mesh[])=>layer.length)).toEqual([2,2]);
    const edges=network.children.find((child:THREE.Object3D)=>child instanceof THREE.LineSegments) as THREE.LineSegments;
    const positions=edges.geometry.getAttribute('position');
    expect(positions.count).toBe(8);
    expect([positions.getX(0),positions.getY(0),positions.getZ(0)]).toEqual(network.userData.layers[0][0].position.toArray());
    const colors=edges.geometry.getAttribute('color');
    expect(colors.getY(0)).toBeGreaterThan(colors.getX(0));
    expect(colors.getX(2)).toBeGreaterThan(colors.getY(2));
  });
});
