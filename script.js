import nodePositionsCache from "./data/node_positions_cache.json" with { type: "json" };

window.stopNDump = false;
function djb2Hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        // Equivalent to: hash * 33 + current character code
        hash = (hash << 5) + hash + str.charCodeAt(i);
        hash |= 0; // Convert to a 32-bit signed integer
    }
    return Math.abs(hash);
}

const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
canvas.width = canvas.getBoundingClientRect().width;
canvas.height = canvas.getBoundingClientRect().height;

const RADIUS = 10;
const k_c = 600_000; // coulomb constant for node repulsion //Math.pow(4 * Math.PI * 8.8541878128, -1) * Math.pow(10, 2)
let ZOOM_COEFF = 1;
let OFFSET_X = canvas.width * 0.5, OFFSET_Y = canvas.height * 0.5;
let latestTree;
let focusedNode = null;
let urlHash;
// let expiry;

let nodeNameToIndexMap;
const cursor = {x: null, y: null};
let fixedNode = null;

const BASE_URL = "https://mcgill-cg-api.botato.workers.dev"
const CHAT_API = BASE_URL + "/chat";
const COURSES_API = BASE_URL + "/courses?all";
let conversation_history = [];

let turnstileToken = null;
window.onTurnstileSuccess = (token) => { turnstileToken = token; };
setInterval(() => {
    if (window.turnstile) {
        window.turnstile.reset(".cf-turnstile");
        turnstileToken = null;
    }
}, 10 * 60 * 1000);

let courses = [];
async function fetchCourses() {
    urlHash = djb2Hash(COURSES_API);

    // const cache = localStorage.getItem(urlHash);
    // if (cache !== null && JSON.parse(cache).expiry > new Date().getTime()) {
    //     expiry = JSON.parse(cache).expiry;
    //     return JSON.parse(cache).data;
    // }

    const req = await fetch(COURSES_API);
    const body = await req.json();
    if (!body.success) throw new Error(body.message);
    // expiry = new Date().getTime() + 3*60*60*1000;

    // the https://mcgill.courses api has so much
    // data; the people who made it are THE goats 

    const flattenIds = (node) => {
        if (!node) return [];
        if (node.type === "course") return [node.data.replace(/\s/g, "")];
        return node.data.groups.flatMap(flattenIds);
    };

    const res = body.data.map((c) => {
        const instructors = c.instructors_and_semesters.filter(s => s.startsWith("Prof."));
        const semesters = c.instructors_and_semesters.filter(s => !s.startsWith("Prof."));
        return {
            id: c.id,
            name: c.name,
            description: c.description,
            instructors,
            semesters,
            prereqs: [
                ...flattenIds(c.logicalPrerequisites),
                ...flattenIds(c.logicalCorequisites),
            ],
            prereqsText: c.prereqsText,
            coreqsText: c.coreqsText,
            restrictionsText: c.restrictionsText,
        };
    }).sort((a, b) => a.id.localeCompare(b.id));

    // localStorage.setItem(urlHash, JSON.stringify({ data: res, expiry }));
    return res
}

// draws a directed edge tail -> head (both are node objects), with an arrowhead
// sitting just outside the head node's dot so it isn't swallowed by it
function addEdgeToPath(shaftPath, headPath, tail, head) {
    const x1 = tail.x*ZOOM_COEFF+OFFSET_X, y1 = tail.y*ZOOM_COEFF+OFFSET_Y;
    const x2 = head.x*ZOOM_COEFF+OFFSET_X, y2 = head.y*ZOOM_COEFF+OFFSET_Y;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    // pull the tip back to the rim of the head dot
    const gap = (RADIUS + 3) * ZOOM_COEFF;
    const tipX = x2 - gap*Math.cos(angle);
    const tipY = y2 - gap*Math.sin(angle);

    const head_len = Math.max(10, 12 * ZOOM_COEFF);
    const spread = Math.PI / 7;

    // stop the shaft at the arrowhead's base (not the apex) so the flat line-cap
    // can't poke out past the tip: the triangle alone makes the point
    const back = head_len * Math.cos(spread);
    const baseX = tipX - back*Math.cos(angle);
    const baseY = tipY - back*Math.sin(angle);

    // shaft
    shaftPath.moveTo(x1, y1);
    shaftPath.lineTo(baseX, baseY);

    // arrowhead
    headPath.moveTo(tipX, tipY);
    headPath.lineTo(tipX - head_len*Math.cos(angle - spread), tipY - head_len*Math.sin(angle - spread));
    headPath.lineTo(tipX - head_len*Math.cos(angle + spread), tipY - head_len*Math.sin(angle + spread));
    headPath.closePath();
}

function drawEdgeGroup(nodes ,edgeList, color, width) {
    const shaftPath = new Path2D();
    const headPath = new Path2D();
    for (const edge of edgeList) {
        addEdgeToPath(shaftPath, headPath, nodes[edge[1]], nodes[edge[0]]);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke(shaftPath);
    ctx.fillStyle = color;
    ctx.fill(headPath);
}

function render(nodes, edges, neighbours) {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fontSizeConstant = Math.min(canvas.width, canvas.height) * 0.05;
    const fontSize = fontSizeConstant * ZOOM_COEFF;

    if (nodes !== render._cachedNodes) {
        // thanks claude for these mappings/conversion code
        const depts = [...new Set(nodes.map(n => n.dept))];
        render._hueOf = Object.fromEntries(depts.map((d, i) => [d, (i * 137.508) % 360]));
        render._deptObj = Object.fromEntries(depts.map((d) => [d, `hsla(${render._hueOf[d]}, 70%, 50%, 0.1)`]));
        render._cachedNodes = nodes;
    }

    // cute backgrounds: dominant dept per cell is resolved here (render-only), no longer
    // in the per-frame physics pass. Only recompute when update() built a fresh tree,
    // during pan/zoom the tree is unchanged, so the result would be identical every frame.
    if (render._deptTree !== latestTree) {
        latestTree.computeDepts();
        render._deptTree = latestTree;
    }
    latestTree.drawCells(ctx, render._deptObj);

    // edges: prereq -> course (so the arrow points at what the prereq unlocks)
    // edge = [course, prereq], so tail = nodes[edge[1]] (prereq), head = nodes[edge[0]] (course).
    const focusEdge = (e) => focusedNode !== null && (focusedNode === e[0] || focusedNode === e[1]);
    // dim/background edges first, focused ones on top
    if (render._cachedFocus !== focusedNode) {
        render._bgEdges = []; render._fgEdges = [];
        for (const e of edges) (focusEdge(e) ? render._fgEdges : render._bgEdges).push(e);
        render._cachedFocus = focusedNode;
    }
    drawEdgeGroup(nodes, render._bgEdges, focusedNode !== null ? "#3c3c3cc0" : "black", Math.max(1, 2.0*ZOOM_COEFF));
    drawEdgeGroup(nodes, render._fgEdges, "black", Math.max(2, 3.0*ZOOM_COEFF));

    // nodes
    ctx.strokeStyle = "#3c3c3cc0";
    ctx.font = fontSize + "px monospace";
    const normalDots = new Path2D(), dimmedDots = new Path2D();
    const dotR = Math.max(2, RADIUS*ZOOM_COEFF);
    const showLabels = fontSize >= 6;                 // below this labels are illegible mush: skip them
    const W = canvas.width, H = canvas.height;
    for (let i=0;i<nodes.length;i++) {
        const node = nodes[i];
        const sx = node.x*ZOOM_COEFF+OFFSET_X;
        const sy = node.y*ZOOM_COEFF+OFFSET_Y;

        // viewport cull, sized to what this node actually draws: the dot (radius dotR) plus,
        // when shown, its centered label (extends labelW/2 sideways and ~1.3*fontSize upward)
        const labelW = showLabels ? fontSize*0.6*node.name.length : 0;
        const marginX = Math.max(dotR, labelW*0.5);
        const marginTop = showLabels ? Math.max(dotR, fontSize*1.3) : dotR;
        if (sx < -marginX || sx > W + marginX || sy < -marginTop || sy > H + dotR) continue;

        const dimmed = focusedNode !== null && neighbours[focusedNode] && focusedNode !== i && !neighbours[focusedNode].has(i);

        if (showLabels) {
            // label background
            ctx.fillStyle = dimmed ? "#ffffff2f" : "#ffffff9f";
            ctx.fillRect(sx - labelW*0.5, sy - fontSize*1.3, labelW, fontSize*0.9);
            // label text
            ctx.fillStyle = dimmed ? "#3c3c3cc0" : "black";
            ctx.fillText(node.name, sx - labelW*0.5, sy - fontSize*0.5);
        }

        // dot: queued into one of two batched paths instead of drawn immediately
        const dots = dimmed ? dimmedDots : normalDots;
        dots.moveTo(sx + dotR, sy);
        dots.arc(sx, sy, dotR, 0, 2*Math.PI);
    }
    ctx.fillStyle = "black";
    ctx.fill(normalDots);
    ctx.fillStyle = "#3c3c3cc0";
    ctx.fill(dimmedDots);
    // ctx.beginPath();
    // ctx.arc(cursor.x*ZOOM_COEFF+OFFSET_X, cursor.y*ZOOM_COEFF+OFFSET_Y, RADIUS, 0, 2*Math.PI);
    // ctx.fillStyle = "pink";
    // ctx.fill();
    // ctx.stroke();

    // ctx.fillStyle = "black";
    // ctx.font = Math.min(canvas.width, canvas.height) * 0.025 + "px monospace";
    // ctx.fillText(
    //     `${ZOOM_COEFF<0.1?"0":""}${ZOOM_COEFF<1?"0":""}${ZOOM_COEFF<10?"0":""}${Math.round(ZOOM_COEFF.toFixed(2)*100)}% zoom`,
    //     window.innerWidth-(fontSizeConstant*0.6*5)-5,
    //     window.innerHeight-5);
}

function selectCourse(courseId, nodes) {
    const courseElem = document.querySelector("#course");
    const pillsElem = document.querySelector(".pills");
    const prereqsElem = document.querySelector("#prereqs");
    const coreqsElem = document.querySelector("#coreqs");
    const restrictionsElem = document.querySelector("#restrictions");
    const descElem = document.querySelector("#description");

    if (courseId === null) {
        if (focusedNode !== null) {
            nodes[focusedNode].charge = 10;
            nodes[focusedNode].k = 1;
            nodes[focusedNode].mass = 5;
            focusedNode = null;
            courseElem.textContent = "Nothing, for now.";
            descElem.textContent = "";
            prereqsElem.textContent = "Prequisites:";
            coreqsElem.textContent = "Corequisites:";
            restrictionsElem.textContent = "";
            pillsElem.replaceChildren([]);
        }
        return;
    }

    if (!nodeNameToIndexMap) return;
    const idx = nodeNameToIndexMap.indexOf(courseId);
    if (idx === -1) return;

    if (focusedNode !== null && focusedNode !== idx) {
        nodes[focusedNode].charge = 10;
        nodes[focusedNode].k = 1;
        nodes[focusedNode].mass = 5;
    }
    focusedNode = idx;
    nodes[idx].charge = 1;
    nodes[idx].k = 1;
    nodes[idx].mass = 0.1;

    const course = nodes[idx].course;

    courseElem.textContent = course.id + ": " + course.name;
    descElem.textContent = course.description;
    pillsElem.replaceChildren();
    for (const item of course.instructors.concat(course.semesters).filter(Boolean)) {
        const elem = document.createElement("li");
        elem.textContent = item;
        pillsElem.appendChild(elem);
    }
    prereqsElem.textContent = course.prereqsText;
    coreqsElem.textContent = course.coreqsText;
    restrictionsElem.textContent = course.restrictionsText;
}

function _2d_euclidian_distance(node1, node2, sqrt=true) {
    const dx = node2.x - node1.x;
    const dy = node2.y - node1.y;
    if (sqrt) {
        return Math.sqrt(dx*dx + dy*dy);
    } else {
        return dx*dx + dy*dy;
    }
}

class Cell {
    constructor() {
        this.side = this.rootX = this.rootY = 0;
        this.children = [];
        this.body = null; // a node, basically
        this.charge = this.cocX = this.cocY = 0;
        // this.state = 0; // 0 is empty, 1 is has one child, 2 is has cells inside it (and therefore gets a mass&center of mass)
        this._dept = null; // dominant department, computed lazily at render time (see computeDepts)
    }

    build_bounding_box(nodes) {
        // find max x and y in any quadrant
        let max_x = -Infinity, max_y = -Infinity;
        let min_x = Infinity, min_y = Infinity;
        for (const node of nodes) {
            if (node.x < min_x) min_x = node.x;
            if (node.x > max_x) max_x = node.x;
            if (node.y < min_y) min_y = node.y;
            if (node.y > max_y) max_y = node.y;
        }
        this.side = Math.max(max_y-min_y, max_x-min_x) + 2; // 2 is a tiny margin to make sure the extreme nodes are inside the shape
        this.rootX = min_x;
        this.rootY = min_y;

        return this;
    }

    insert(bodies, depth=0) {
        if (bodies.length === 0)  return;
        if (bodies.length === 1 || depth > 48) { this.body = bodies[0]; return; }

        const quadrant = [[], [], [], []];
        for (let i=0; i<bodies.length; i++) {
            let quadrantId;
            if (bodies[i].x <= this.rootX+this.side/2) {
                if (bodies[i].y <= this.rootY+this.side/2) {
                    quadrantId = 2;
                } else {
                    quadrantId = 0;
                }
            } else {
                if (bodies[i].y <= this.rootY+this.side/2) {
                    quadrantId = 3;
                } else {
                    quadrantId = 1;
                }
            }
            quadrant[quadrantId].push(bodies[i]);
        }
        for (let i=0; i<4; i++) {
            const cell = new Cell();
            cell.side = this.side/2;
            cell.rootX = i % 2 === 0 ? this.rootX : this.rootX + cell.side;
            cell.rootY = i >= 2 ? this.rootY : this.rootY + cell.side;
            this.children.push(cell);
            cell.insert(quadrant[i], depth+1);
        }

        return this;
    }

    precomputeCharges() {
        if (this.children.length === 0) {
            if (this.body === null) return this;
            this.charge = this.body.charge;
            this.cocX = this.body.x;
            this.cocY = this.body.y;
            return this;
        }

        this.charge = this.cocX = this.cocY = 0;

        for (const child of this.children) {
            child.precomputeCharges();
            if (child.charge === 0) continue;
            this.charge += child.charge;
            this.cocX += child.cocX * child.charge;
            this.cocY += child.cocY * child.charge;
        }

        if (this.charge === 0) { this.cocX = this.cocY = 0; return this; }

        this.cocX /= this.charge;
        this.cocY /= this.charge;

        return this;
    }

    // dominant-department computation, done bottom-up. Kept OUT of precomputeCharges
    // (physics hot path) and run only at render time via computeDepts(). Assigns
    // this._dept and returns the subtree's {dept: count} histogram.
    computeDepts() {
        if (this.children.length === 0) {
            if (this.body === null) { this._dept = null; return null; }
            this._dept = this.body.dept;
            return { [this._dept]: 1 };
        }

        const hist = {};
        for (const child of this.children) {
            const childHist = child.computeDepts();
            if (!childHist) continue;
            for (const k in childHist) hist[k] = (hist[k] || 0) + childHist[k];
        }

        // pick the most-represented dept with a plain loop (no Object.entries/reduce allocs)
        let dept = "?", best = 0;
        for (const k in hist) if (hist[k] > best) { best = hist[k]; dept = k; }
        this._dept = dept;
        return hist;
    }

    // accumulates this cell's repulsion on `node` into acc.{fx,fy}. Writing into a
    // shared accumulator (instead of returning [fx,fy] and reducing over children)
    // avoids O(log N) throwaway arrays per node per frame.
    computeForceInto(node, acc) {
        if (this.children.length === 0 && (this.body === null || this.body === node)) return;

        const dx = this.cocX - node.x;
        const dy = this.cocY - node.y;
        const d_squared = dx*dx + dy*dy;

        if (this.children.length === 0 || this.side * this.side < 0.81 * d_squared) {
            // coulomb for a single point / far-enough cluster. The force points from the
            // centre of charge to the node, i.e. along (node - coc)/|node - coc|, so we
            // normalise with 1/sqrt instead of atan2+cos+sin (3 transcendentals -> 1 sqrt).
            const magnitude = k_c * this.charge * node.charge / Math.max(d_squared, 10000);
            const invDist = 1 / Math.sqrt(Math.max(d_squared, 1e-9)); // guard d²==0 (node atop coc)
            acc.fx += magnitude * (node.x - this.cocX) * invDist;
            acc.fy += magnitude * (node.y - this.cocY) * invDist;
            return;
        }

        // too close! recurse into children
        for (const cell of this.children) cell.computeForceInto(node, acc);
    }

    drawCells(ctx, deptColorMapping) {
        if (this.children.length === 0 && this.body === null) return;
        const x = this.rootX*ZOOM_COEFF + OFFSET_X;
        const y = this.rootY*ZOOM_COEFF + OFFSET_Y;
        const s = this.side*ZOOM_COEFF;

        // sub-pixel: this cell and its (always-smaller) descendants draw nothing: prune the subtree
        if (s < 1) return;
        // subtree entirely offscreen: children live inside this box, so skip them too
        if (x + s < 0 || y + s < 0 || x > ctx.canvas.width || y > ctx.canvas.height) return;

        ctx.fillStyle = deptColorMapping[this._dept] || "transparent";
        ctx.fillRect(x, y, s, s);
        for (const c of this.children) c.drawCells(ctx, deptColorMapping);
    }
}

function update(nodes, edges, neighbours, real_timedelta, stopped = false, alpha = 1, damping = 0.7) {
    const k_s_base = 3; //200;
    // debugger;

    if (!stopped || fixedNode !== null) {
        latestTree = new Cell()
            .build_bounding_box(nodes)
            .insert(nodes)
            .precomputeCharges();
    }
    const quadtree = latestTree;

    const dt = Math.min(0.05, real_timedelta); // constant per frame: hoisted out of the node loop
    const acc = { fx: 0, fy: 0 };               // reused across nodes to avoid per-node allocation

    for (let i=0; i<nodes.length; i++) {
        const node = nodes[i];

        if (node.fixed && cursor.x !== null && cursor.y !== null) {
            node.vx = (cursor.x - node.x) / dt * 0.5;
            node.vy = (cursor.y - node.y) / dt * 0.5;
            node.x = cursor.x;
            node.y = cursor.y;
            continue;
        }

        if (stopped) continue;

        // repulsion: coulomb's law (Barnes-Hut)
        acc.fx = 0; acc.fy = 0;
        quadtree.computeForceInto(node, acc);
        let SFx = acc.fx, SFy = acc.fy;

        // attraction: hooke's law. |F| = k_s * dist along the edge; normalising that by
        // dist to get the direction cancels the dist, so the force is just k_s * delta:
        // no sqrt/atan2/cos/sin needed (identical result to the trig form).
        for (const edgeNode of neighbours[i]) {
            const k_s = focusedNode === edgeNode ? k_s_base * 5 : k_s_base;
            SFx += k_s * (nodes[edgeNode].x - node.x);
            SFy += k_s * (nodes[edgeNode].y - node.y);
        }

        if (neighbours[i].size === 0 && SFx*SFx + SFy*SFy < 5) {
            node.vx = 0;
            node.vy = 0;
            continue;
        }

        const a_x = SFx / node.mass;
        const a_y = SFy / node.mass;

        node.vx += a_x * dt * alpha;
        node.vy += a_y * dt * alpha;

        node.vx *= damping;
        node.vy *= damping;

        node.x += node.vx * dt;
        node.y += node.vy * dt;
    }
}

async function populate() {
    const h = Math.min(canvas.width, canvas.height);
    const courses = await fetchCourses();
    // console.log(courses);

    nodeNameToIndexMap = courses.map((c) => c.id);
    let neighbours = nodeNameToIndexMap.map(() => new Set());

    // id -> index / id -> course lookups built once, so edge-building and node hydration
    // are O(1) per lookup instead of indexOf/find (previously O(N²) over ~2000 courses)
    const idToIndex = new Map(courses.map((c, i) => [c.id, i]));
    const idToCourse = new Map(courses.map((c) => [c.id, c]));
    const deptOf = (name) => (name.match(/[A-Z]{4}/) || ["?"])[0];

    const edges = [];
    courses.forEach((curr, from) => {
        // `from` is the course's own index (courses and nodeNameToIndexMap share order)
        for (const prereq of curr.prereqs) {
            const to = idToIndex.get(prereq);
            if (to === undefined) continue;
            edges.push([from, to]);
        }
    });

    for (const [from, to] of edges) {
        neighbours[from].add(to);
        neighbours[to].add(from);
    }

    let nodes;
    if (urlHash === 905575632 || urlHash === 2068739592) {
        console.log("importing node positions from cache");
        nodes = nodePositionsCache.nodes;
        nodes.forEach((node) => {
            node.course = idToCourse.get(node.name);
            node.dept = deptOf(node.name);
        });
    } else {
        nodes = courses.map((course) => ({
            name: course.id,
            fixed: false,
            course,
            dept: deptOf(course.id), // precomputed so the physics/render paths never re-run the regex
            charge: 10, // constant for now
            mass: 5, // same as above
            vx: 0,
            vy: 0,
            x: (Math.random() - 0.5) * h * 4,
            y: (Math.random() - 0.5) * h * 4,
        }));
    }

    return { nodes, edges, neighbours };
}

// function fake_data_populate() {
//     let nodes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10].map(()=>({}));
//     let edges = [[0, 1], [0, 2], [0, 3], [0, 4], [4, 5], [3, 6], [3, 2]];
//     const h = Math.min(canvas.width, canvas.height);
//     const nodeCount = nodes.length;
//     let neighbours = [];

//     for (let i=0; i<nodeCount; i++) {
//         nodes[i].name = "BOB"
//         nodes[i].fixed = false;
//         nodes[i].charge = 3; // constant for now
//         nodes[i].mass = 3; // same as above
//         nodes[i].x = h/10*Math.cos(2*Math.PI/nodeCount*(i+1));
//         nodes[i].y = h/10*Math.sin(2*Math.PI/nodeCount*(i+1));
//         neighbours[i] = new Set(edges.filter((e) => e.includes(i)).flat().filter(n => n !== i))
//     };

//     render(nodes, edges);
//     return { nodes, edges, neighbours };
// }

let turnstileSucceeded = false;
function onTurnstileSuccess() {
    turnstileSucceeded = true;
}

async function initiate() {
    const { nodes, edges, neighbours } = await populate();

    const zero = document.timeline.currentTime;

    let settled = false;

    function totalKE(nodes) {
        let ke = 0;
        for (const n of nodes) ke += n.vx*n.vx + n.vy*n.vy;
        return ke
    } 

    requestAnimationFrame(animate);

    let alpha = 1;
    let quietFrames;
    function animate(timestamp) {
        const real_timedelta = timestamp - zero;
        if (!settled) {
            alpha *= 1 - 0.0001;
            update(nodes, edges, neighbours, real_timedelta, false, alpha);
            let ke = totalKE(nodes);
            if ((nodes.length >= 500 && (alpha < 0.0000001 || ke < 0.001 * nodes.length)) || window.stopNDump) {   // scale epsilon by node count
                quietFrames = (quietFrames || 0) + 1;
                if (quietFrames > 30) { // stable for ~30 frames → stop
                    settled = true;
                    // strip the heavy embedded course object before caching since it's redundant
                    const slimNodes = nodes.map(({ course, ...rest }) => rest);
                    try {
                        localStorage.setItem(urlHash + "_n", JSON.stringify({ nodes: slimNodes }));
                    } catch (e) {
                        console.warn("position cache skipped (storage full):", e.name);
                    }
                }
            } else quietFrames = 0;
        } else {
            update(nodes, edges, neighbours, real_timedelta, true);
        }
        // console.log(neighbours);
        render(nodes, edges, neighbours);

        requestAnimationFrame(animate);
    }

    let mouseDown = false;
    let prevX = null, prevY = null;
    let startX = 0, startY = 0, dragging = false;
    document.addEventListener("mousemove", (event) => {
        const rect = canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;

        // only treat it as a drag once the pointer leaves a small dead zone,
        // so a click with a few px of jitter isn't mistaken for a pan
        if ((mouseDown || fixedNode !== null) && !dragging && Math.hypot(px - startX, py - startY) > 5) {
            dragging = true;
        }

        if (mouseDown && dragging && prevX !== null && prevY !== null) {
            OFFSET_X += px - prevX;
            OFFSET_Y += py - prevY;
        }
        prevX = px;
        prevY = py;

        if (fixedNode !== null) {
            cursor.x = (px - OFFSET_X) / ZOOM_COEFF;
            cursor.y = (py - OFFSET_Y) / ZOOM_COEFF;
        }
    });

    let mouseDownMoment, potentiallyClickedNode, mouseDownOnCanvas = false;
    canvas.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return; // we want left clicks only
        mouseDownMoment = document.timeline.currentTime;
        potentiallyClickedNode = null;
        mouseDownOnCanvas = true;

        const rect = canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        startX = prevX = px;
        startY = prevY = py;
        dragging = false;

        let closest_node = null;
        let closest_node_distance = 20;

        for (let i=0; i<nodes.length; i++) {
            const distance = _2d_euclidian_distance({x: (px-OFFSET_X)/ZOOM_COEFF, y: (py-OFFSET_Y)/ZOOM_COEFF}, nodes[i]); // hihihihi
            if (distance < closest_node_distance && distance < 2*RADIUS/ZOOM_COEFF) {
                closest_node_distance = distance;
                potentiallyClickedNode = closest_node = i;
            }
        }

        if (closest_node !== null) {
            nodes[closest_node].fixed = true;
            fixedNode = closest_node;
            return;
        }

        mouseDown = true;
    });

    document.addEventListener("mouseup", (event) => {
        if (!mouseDownOnCanvas) return;
        mouseDownOnCanvas = false;
        const wasClick = !dragging;        // stayed inside the dead zone → a click, not a pan/drag
        mouseDown = false;

        // release a dragged node, if there was one
        if (fixedNode !== null) {
            nodes[fixedNode].fixed = false;
            fixedNode = null;
            cursor.x = null;
            cursor.y = null;
        }

        if (!wasClick) return;             // it was a pan or node-drag: leave focus alone

        if (potentiallyClickedNode !== null && potentiallyClickedNode !== focusedNode) {
            // clicked a new node → focus it + open the panel
            selectCourse(nodes[potentiallyClickedNode].course.id, nodes);
            potentiallyClickedNode = null;
        } else if (focusedNode !== null) {
            // clicked empty space (or the focused node again) → deselect
            selectCourse(null, nodes);
            potentiallyClickedNode = null;
        }
        // clicking empty space with nothing focused → no-op (no more null crash)
    });

    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        const epsilon = 1e-5;
        const step = ((event.deltaY < 0 ? event.deltaY * 2 : event.deltaY) + epsilon) / (event.deltaY * 2 + epsilon) + 0.2;

        const rect = canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;

        const wx = (px - OFFSET_X) / ZOOM_COEFF;
        const wy = (py - OFFSET_Y) / ZOOM_COEFF;

        ZOOM_COEFF *= step;

        OFFSET_X = px - wx * ZOOM_COEFF;
        OFFSET_Y = py - wy * ZOOM_COEFF;
    }, { passive: false });

    const conversationElem = document.querySelector(".conversation");

    function appendMessage(text) {
        const div = document.createElement("div");
        div.className = "message";
        div.textContent = text;
        conversationElem.appendChild(div);
        conversationElem.scrollTop = conversationElem.scrollHeight;
    }

    async function sendChat(text) {
        appendMessage(text);
        if (!turnstileToken) {
            await new Promise(r => {
                const i = setInterval(() => {
                    if (turnstileToken) { clearInterval(i); r(); }
                }, 50);
            });
        }
        const tokenToSend = turnstileToken;
        turnstileToken = null;
        try {
            const req = await fetch(CHAT_API, {
                method: "POST",
                headers: { "Content-Type": "application/json", "cf-turnstile-response": tokenToSend },
                body: JSON.stringify({ query: text, conversation_history }),
            });
            const json = await req.json();
            if (!json.success) {
                appendMessage("error: " + json.message);
                return;
            }
            conversation_history = json.data.conversation_history;
            appendMessage(json.data.response);
            console.log("Assistant:", json.data.response);
            if (json.data.highlight_course) {
                selectCourse(null, nodes);
                selectCourse(json.data.highlight_course, nodes);
            }
        } catch (e) {
            appendMessage("error: " + e.message);
        } finally {
            turnstile.reset();
        }
    }

    const chatbox = document.querySelector("input.chatbox");
    chatbox.onkeypress = (event) => {
        if (!event) event = window.event;
        const keyCode = event.code || event.key;
        if (keyCode === 'Enter') {
            const text = chatbox.value.trim();
            if (text) {
                chatbox.value = "";
                sendChat(text);
            }
            return false;
        }
    }

}
initiate();
