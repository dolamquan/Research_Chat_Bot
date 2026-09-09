const state = {};

function init(ctx) {
  const THREE = ctx.THREE;
  // Example: 6 tables with 2D features (for visualization)
  state.names = ["T1", "T2", "T3", "T4", "T5", "T6"];
  state.features = [
    [0.1, 0.2],
    [0.2, 0.1],
    [0.15, 0.25],
    [0.8, 0.7],
    [0.75, 0.8],
    [0.78, 0.6],
  ];
  state.n = state.features.length;

  // Pre-allocated reusable vectors
  state.vecs = [];
  for (let i = 0; i < state.n; i++) state.vecs.push(new THREE.Vector3());

  // Scene group for this stage
  state.group = new THREE.Group();
  ctx.scene.add(state.group);

  // Layout: inputs on left, nodes in middle, outputs (bars) on right
  const leftX = -6, midX = 0, rightX = 6;
  state.leftX = leftX; state.midX = midX; state.rightX = rightX;

  // Create node spheres and labels
  state.nodeMeshes = [];
  state.nodeLabels = [];
  const sphereGeom = new THREE.SphereGeometry(0.35, 24, 16);
  state.nodeMat = new THREE.MeshStandardMaterial({ color: 0x0077ff });
  for (let i = 0; i < state.n; i++) {
    const m = new THREE.Mesh(sphereGeom, state.nodeMat.clone());
    // position in middle plane; scatter by features mapped to y,z
    const fx = state.features[i][0], fy = state.features[i][1];
    const y = (fx - 0.5) * 4;
    const z = (fy - 0.5) * 4;
    m.position.set(midX, y, z);
    state.group.add(m);
    state.nodeMeshes.push(m);

    const label = ctx.makeLabel(state.names[i], { size: 0.6, color: "#000" });
    label.position.set(midX, y + 0.6, z);
    state.group.add(label);
    state.nodeLabels.push(label);
  }

  // Input arrow (Table Corpora) on left
  const corpLabel = ctx.makeLabel("Table Corpora", { size: 1.0, color: "#000", background: "rgba(255,255,255,0.7)" });
  corpLabel.position.set(leftX - 1.2, 0, 0);
  state.group.add(corpLabel);

  // Draw arrows from left to each node (static)
  const arrowMat = new THREE.LineBasicMaterial({ color: 0x444444 });
  const arrowGeom = new THREE.BufferGeometry();
  // We'll reuse a single geometry for simplicity: a line from leftX to midX
  const pts = new Float32Array(2 * 3);
  arrowGeom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  state.arrows = [];
  for (let i = 0; i < state.n; i++) {
    const g = arrowGeom.clone();
    const line = new THREE.Line(g, arrowMat.clone());
    state.group.add(line);
    state.arrows.push(line);
  }

  // Clusters (KMeans): we animate nodes moving toward centroids.
  state.k = 2; // cluster into 2 groups for clarity
  // Initialize centroids by picking two feature points
  state.centroids = [
    new THREE.Vector3(state.midX, (state.features[0][0]-0.5)*4, (state.features[0][1]-0.5)*4),
    new THREE.Vector3(state.midX, (state.features[3][0]-0.5)*4, (state.features[3][1]-0.5)*4),
  ];
  // Visual markers for centroids
  const centGeom = new THREE.OctahedronGeometry(0.25);
  state.centMeshes = [];
  const colors = [0xffaa00, 0x00aa55];
  for (let i = 0; i < state.k; i++) {
    const m = new THREE.Mesh(centGeom, new THREE.MeshStandardMaterial({ color: colors[i], emissive: colors[i], emissiveIntensity: 0.2 }));
    m.position.copy(state.centroids[i]);
    m.position.x = midX - 1.0; // slightly left to show clustering pull
    state.group.add(m);
    state.centMeshes.push(m);

    const clabel = ctx.makeLabel("Cluster " + (i+1), { size: 0.6, color: "#000", background: "rgba(255,255,255,0.6)" });
    clabel.position.set(midX - 1.4, state.centroids[i].y + 0.6, state.centroids[i].z);
    state.group.add(clabel);
  }

  // Hyperedges (drawn as semi-transparent rings around cluster area)
  state.clusterRings = [];
  for (let i = 0; i < state.k; i++) {
    const ringGeom = new THREE.RingGeometry(1.2, 1.8, 64);
    const mat = new THREE.MeshBasicMaterial({ color: colors[i], side: THREE.DoubleSide, transparent: true, opacity: 0.12 });
    const mesh = new THREE.Mesh(ringGeom, mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(midX, state.centroids[i].y, state.centroids[i].z);
    state.group.add(mesh);
    state.clusterRings.push(mesh);
  }

  // Output bars on right showing PageRank scores
  state.barGroup = new THREE.Group();
  state.group.add(state.barGroup);
  state.bars = [];
  state.barLabels = [];
  for (let i = 0; i < state.n; i++) {
    const g = new THREE.BoxGeometry(0.6, 1.0, 0.6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
    const m = new THREE.Mesh(g, mat);
    const by = (i - (state.n-1)/2) * 0.9;
    m.position.set(rightX, by, 0);
    state.barGroup.add(m);
    state.bars.push(m);
    const lbl = ctx.makeLabel(state.names[i], { size: 0.5, color: "#000" });
    lbl.position.set(rightX + 0.9, by, 0);
    state.barGroup.add(lbl);
    state.barLabels.push(lbl);
  }

  // Caption initial
  ctx.setCaption("Stage: Hierarchical Memory Index — organizing tables into clusters and computing PageRank.");

  // Build adjacency from clusters (we will recompute clusters per frame but preallocate matrices)
  state.P = []; // transition matrix n x n (row-major)
  for (let i = 0; i < state.n * state.n; i++) state.P.push(0);

  // PageRank vectors
  state.h = new Array(state.n).fill(0); // initial personalization
  state.v = new Array(state.n).fill(1 / state.n); // current rank
  state.vnext = new Array(state.n).fill(0);

  // Query: highlight T2 as query-relevant (so initial h favors it slightly)
  state.queryIndex = 1;

  // Timing and phases
  state.CYCLE = 12.0;
  state.phaseTimers = {
    kmeans: 0.0,      // 0-3s: KMeans clustering movement
    init_scores: 3.0, // 3-4s: show initial relevance
    pagerank: 4.0,    // 4-10s: iterative PageRank updates
    select: 10.0      // 10-12s: show selected tables output
  };

  // Precompute positions targets from features for consistent worked example
  state.targetPositions = [];
  for (let i = 0; i < state.n; i++) {
    const fx = state.features[i][0], fy = state.features[i][1];
    const y = (fx - 0.5) * 4;
    const z = (fy - 0.5) * 4;
    state.targetPositions.push(new THREE.Vector3(midX, y, z));
  }

  // Colors for nodes per cluster (updated)
  state.nodeColors = [];
  for (let i = 0; i < state.n; i++) state.nodeColors.push(new THREE.Color(0x0077ff));
}

function update(ctx, t) {
  const THREE = ctx.THREE;
  const C = state.CYCLE;
  const phase = t % C;

  // Phase durations
  const p1 = state.phaseTimers.kmeans;
  const p2 = state.phaseTimers.init_scores;
  const p3 = state.phaseTimers.pagerank;
  const p4 = state.phaseTimers.select;

  // 1) KMeans clustering animation (0 - p1)
  if (phase < p1) {
    const u = phase / p1; // 0->1
    ctx.setCaption("Step 1: Organize tables into a hypergraph and run KMeans clustering (visualizing movement).");

    // Move centroids gently (oscillate a bit for visual)
    for (let k = 0; k < state.k; k++) {
      const c = state.centroids[k];
      const base = k === 0 ? -0.6 : 0.6;
      const oscill = Math.sin(t * 2 + k) * 0.15;
      state.centMeshes[k].position.x = state.midX - 1.0 + base * (1 - u) + oscill * u;
      state.centMeshes[k].position.y = state.centroids[k].y;
      state.centMeshes[k].position.z = state.centroids[k].z;
      // ring follows centroid
      state.clusterRings[k].position.copy(state.centMeshes[k].position);
    }

    // For each node, compute assignment to nearest centroid (in feature-space),
    // then interpolate position toward centroid area
    for (let i = 0; i < state.n; i++) {
      // find nearest centroid by euclidean in feature space (use targetPositions)
      let best = 0, bestd = Infinity;
      for (let k = 0; k < state.k; k++) {
        const cy = state.centroids[k].y, cz = state.centroids[k].z;
        const dy = state.targetPositions[i].y - cy;
        const dz = state.targetPositions[i].z - cz;
        const d = dy*dy + dz*dz;
        if (d < bestd) { bestd = d; best = k; }
      }
      // target is near that centroid mesh position, jittered by original offset
      const centPos = state.centMeshes[best].position;
      const orig = state.targetPositions[i];
      // interpolate from original to centroid area
      const target = new THREE.Vector3(
        THREE.MathUtils.lerp(orig.x, centPos.x + 0.6*(Math.random()-0.5), u),
        THREE.MathUtils.lerp(orig.y, centPos.y + 0.2*(Math.random()-0.5), u),
        THREE.MathUtils.lerp(orig.z, centPos.z + 0.2*(Math.random()-0.5), u)
      );
      // move node smoothly
      state.nodeMeshes[i].position.lerp(target, 0.12);
      state.nodeLabels[i].position.copy(state.nodeMeshes[i].position).add(new THREE.Vector3(0, 0.6, 0));
      // color by cluster
      const col = best === 0 ? new THREE.Color(0xffaa00) : new THREE.Color(0x00aa55);
      state.nodeMeshes[i].material.color.lerp(col, 0.06);
      state.nodeColors[i].lerp(col, 0.06);

      // update arrow positions from left to node
      const p0 = new THREE.Vector3(state.leftX + 0.6, 0, 0);
      const p1v = state.nodeMeshes[i].position.clone();
      const positions = state.arrows[i].geometry.attributes.position.array;
      positions[0] = p0.x; positions[1] = p0.y; positions[2] = p0.z;
      positions[3] = p1v.x; positions[4] = p1v.y; positions[5] = p1v.z;
      state.arrows[i].geometry.attributes.position.needsUpdate = true;
    }
    return;
  }

  // After p1, freeze centroids and rings at their positions
  for (let k = 0; k < state.k; k++) {
    state.clusterRings[k].visible = true;
  }

  // 2) Initial relevance scores (p1 - p2)
  if (phase < p2) {
    ctx.setCaption("Step 2: Compute initial relevance h from the query (personalization vector). Query emphasizes T2.");

    // Set h to be small positive with a bump on queryIndex
    for (let i = 0; i < state.n; i++) {
      state.h[i] = (i === state.queryIndex) ? 0.6 : 0.4 / (state.n - 1);
    }
    // Visualize by coloring and scaling nodes briefly
    for (let i = 0; i < state.n; i++) {
      const s = 0.5 + state.h[i] * 0.8;
      state.nodeMeshes[i].scale.setScalar(s);
      const ec = new THREE.Color().copy(state.nodeMeshes[i].material.color).lerp(new THREE.Color(0xffffff), 1 - state.h[i]);
      state.nodeMeshes[i].material.emissive = ec;
      state.nodeMeshes[i].material.emissiveIntensity = 0.2 * state.h[i];
      // update output bars height to reflect h for a moment
      state.bars[i].scale.y = 0.5 + state.h[i] * 2.0;
      state.bars[i].position.y = (i - (state.n-1)/2) * 0.9;
    }
    return;
  }

  // Build transition matrix P based on cluster co-membership.
  // For simplicity, two nodes are connected if their current node color is similar (cluster assignment)
  // Precompute assignments
  const assign = [];
  for (let i = 0; i < state.n; i++) {
    // compare nodeColors to cent color choices
    const c0 = new THREE.Color(0xffaa00);
    const c1 = new THREE.Color(0x00aa55);
    const d0 = Math.hypot(state.nodeColors[i].r - c0.r, state.nodeColors[i].g - c0.g, state.nodeColors[i].b - c0.b);
    const d1 = Math.hypot(state.nodeColors[i].r - c1.r, state.nodeColors[i].g - c1.g, state.nodeColors[i].b - c1.b);
    assign[i] = (d0 < d1) ? 0 : 1;
  }

  // Create adjacency: fully connected within cluster clique, no inter-cluster links
  for (let i = 0; i < state.n; i++) {
    let rowSum = 0;
    for (let j = 0; j < state.n; j++) {
      const val = (i !== j && assign[i] === assign[j]) ? 1 : 0;
      state.P[i * state.n + j] = val;
      rowSum += val;
    }
    // normalize row to probability of moving from i to j (if isolated, self-loop)
    if (rowSum === 0) {
      // isolated: self-loop
      for (let j = 0; j < state.n; j++) state.P[i * state.n + j] = (j === i) ? 1 : 0;
    } else {
      for (let j = 0; j < state.n; j++) state.P[i * state.n + j] /= rowSum;
    }
  }

  // 3) Iterative personalized PageRank (p2 - p3)
  if (phase < p3) {
    ctx.setCaption("Step 3: Iteratively update v(σ+1) = (1−α)h + α P v(σ) to refine table relevance.");
    const alpha = 0.85;
    // Normalize h to sum to 1
    const sumh = state.h.reduce((a,b)=>a+b,0);
    for (let i = 0; i < state.n; i++) state.h[i] = state.h[i] / sumh;
    // We'll perform a few internal iterations per frame to show smooth convergence
    const iterationsPerFrame = 3;
    for (let it = 0; it < iterationsPerFrame; it++) {
      // vnext = (1-alpha) * h + alpha * P * v
      for (let i = 0; i < state.n; i++) state.vnext[i] = (1 - alpha) * state.h[i];
      for (let i = 0; i < state.n; i++) {
        // accumulate from row i of P? Note: using column-stochastic vs row-stochastic. We built row-stochastic P where rows are from i to j.
        // For PageRank, we want Pv where P_{ji} * v_i, but with our construction we'll treat P^T multiply. So do accumulation properly:
        // Compute (P^T * v): for each j, for each i add P[i,j] * v[i]
      }
      // Efficient: for each source i, distribute v[i] * P_row
      const temp = new Array(state.n).fill(0);
      for (let src = 0; src < state.n; src++) {
        const vi = state.v[src];
        const row = src * state.n;
        for (let dst = 0; dst < state.n; dst++) {
          temp[dst] += state.P[row + dst] * vi;
        }
      }
      for (let j = 0; j < state.n; j++) {
        state.vnext[j] += alpha * temp[j];
      }
      // swap v and vnext
      for (let i = 0; i < state.n; i++) state.v[i] = state.vnext[i];
    }

    // Visualize v: node scales and bar heights, and label a numeric fraction
    for (let i = 0; i < state.n; i++) {
      const score = state.v[i];
      const scale = 0.6 + score * 4.0;
      state.nodeMeshes[i].scale.lerp(new THREE.Vector3(scale, scale, scale), 0.2);
      // color intensity proportional to score (brighter if higher)
      const baseColor = state.nodeColors[i];
      const bright = baseColor.clone().lerp(new THREE.Color(0xffffff), 1 - Math.min(1, score*5));
      state.nodeMeshes[i].material.color.lerp(bright, 0.12);
      // bars
      state.bars[i].scale.y = THREE.MathUtils.lerp(state.bars[i].scale.y, 0.5 + score * 4.0, 0.12);
      const by = (i - (state.n-1)/2) * 0.9;
      state.bars[i].position.set(state.rightX, by, 0);
      state.bars[i].material.color.lerp(new THREE.Color(0x44bb88).lerp(new THREE.Color(0x4488ff), 0.5), 0.04);
    }
    return;
  }

  // 4) Selection and output (p3 - p4)
  if (phase < p4) {
    ctx.setCaption("Step 4: Select top-k relevant tables to send to Coarse-Grained Retrieval. Top-2 highlighted.");
    // pick top-2 by v
    const pairs = state.v.map((val, idx) => ({ val, idx }));
    pairs.sort((a,b)=>b.val - a.val);
    const topk = [pairs[0].idx, pairs[1].idx];

    for (let i = 0; i < state.n; i++) {
      const isTop = topk.includes(i);
      // pulse top ones
      state.nodeMeshes[i].material.emissive = new THREE.Color(isTop ? 0xffff88 : 0x000000);
      state.nodeMeshes[i].material.emissiveIntensity = isTop ? 0.8 : 0.0;
      state.nodeMeshes[i].scale.lerp(new THREE.Vector3(isTop ? 1.8 : 0.9, isTop ? 1.8 : 0.9, isTop ? 1.8 : 0.9), 0.12);
      // move bars slightly outward to indicate output flow
      const targetX = isTop ? state.rightX + 1.2 : state.rightX;
      state.bars[i].position.x = THREE.MathUtils.lerp(state.bars[i].position.x, targetX, 0.08);
      // label outputs
      state.barLabels[i].position.x = state.bars[i].position.x + 0.9;
    }

    // Add a rightmost label representing Coarse-Grained Retrieval
    if (!state.coarseLabel) {
      state.coarseLabel = ctx.makeLabel("Coarse-Grained Retrieval", { size: 0.9, color: "#000", background: "rgba(255,255,255,0.8)" });
      state.coarseLabel.position.set(state.rightX + 2.6, 0, 0);
      state.group.add(state.coarseLabel);
    }
    return;
  }

  // default: loop back, slowly reset visuals to initial layout
  ctx.setCaption("Cycle complete — replaying. The pipeline organizes, scores, and selects tables.");
  // gently relax nodes back to targetPositions
  for (let i = 0; i < state.n; i++) {
    state.nodeMeshes[i].position.lerp(state.targetPositions[i], 0.04);
    state.nodeLabels[i].position.copy(state.nodeMeshes[i].position).add(new THREE.Vector3(0, 0.6, 0));
    state.nodeMeshes[i].material.emissiveIntensity = THREE.MathUtils.lerp(state.nodeMeshes[i].material.emissiveIntensity || 0, 0.0, 0.05);
    state.bars[i].position.x = THREE.MathUtils.lerp(state.bars[i].position.x, state.rightX, 0.06);
    state.barLabels[i].position.x = state.bars[i].position.x + 0.9;
    state.nodeMeshes[i].scale.lerp(new THREE.Vector3(1,1,1), 0.06);
  }
}