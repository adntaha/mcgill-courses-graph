import coursesCache from './data/courses_cache.json' with { type: 'json' };
import nodePositionsCache from './data/node_positions_cache.json' with { type: 'json' };

localStorage.setItem("602840604", JSON.stringify(coursesCache));
localStorage.setItem("602840604_n", JSON.stringify(nodePositionsCache));

const SEMESTERS = ["Fall 2026", "Winter 2027"]
let stopNDump = false;
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
let ZOOM_COEFF = 1;
let OFFSET_X = (canvas.width * ZOOM_COEFF) * 0.5, OFFSET_Y = (canvas.height * ZOOM_COEFF) * 0.5;
let latestTree;
let focusedNode = null;
let urlHash;
let expiry;

let nodeNameToIndexMap;
const cursor = {x: null, y: null};
let fixedNode = null;

let courses = [];
async function fetchCourses() {
    const url = `https://mcgill.courses/api/courses?terms=${SEMESTERS.join(",")}&subjects=MATH,COMP,ECSE,PHIL,PHYS,MIMM,BIOL,CHEM,PHAR,PHGY`; // 
    urlHash = djb2Hash(url).toString();
    let res;

    const cache = localStorage.getItem(urlHash);
    if (cache !== null && JSON.parse(cache).expiry > new Date().getTime()) {
        res = JSON.parse(cache).data;
        expiry = JSON.parse(cache).expiry;
    } else {
        const req = await fetch(url);
        const data = await req.json();
        expiry = new Date().getTime() + 7*24*60*60*1000;

        res = [];
        // ts has so much data; the people who made it are THE goats
        // but sadly i dont need that much data for this project

        // TODO: logicalPrerequisites + corequistes + logicalCorequisites logic
        for (const course of data.courses.sort((a, b) => a._id.localeCompare(b._id))) {
            let obj = {};
            // obj.id = course.subject + " " + course.code;
            obj.id = course._id;
            obj.name = course.title;
            obj.description = course.description;
            obj.instructors = course.instructors.reduce((all, instructor) => {
                if (!SEMESTERS.includes(instructor.term)) return all;
                all.push("Prof. " + instructor.name + " (" + instructor.term + ")");
                return all;
            }, []).filter(Boolean);
            if (obj.instructors.length === 0) {
                obj.semesters = course.terms.reduce((all, semester) => {
                    for (const instr of obj.instructors) {
                        if (instr.includes(semester)) return all;
                    }
                    if (SEMESTERS.includes(semester)) all.push(semester);
                    return all;
                }, []).filter(Boolean);
            }
            console.log(obj.instructors)
            obj.prereqs = course.prerequisites.concat(course.corequisites)
            obj.prereqsText = course.prerequisitesText === "This course has no prerequisites." ? "Prerequisites: " + course.prerequisitesText : course.prerequisitesText;
            obj.prereqsText = obj.prereqsText  ?? "Prerequisites: This course has no prerequisites.";
            obj.coreqsText = course.corequisitesText === "This course has no corequisites." ? "Corequisites: " + course.corequisitesText : course.corequisitesText;
            obj.coreqsText = obj.coreqsText ?? "Corequisites: This course has no corequisites.";
            obj.restrictionsText = course.restrictionsText ?? "This course has no restrictions.";
            res.push(obj);
        }

        localStorage.setItem(urlHash, JSON.stringify({data: res, expiry}))
    }


    return res
}

function render(nodes, edges, neighbours) {
    canvas.width = canvas.getBoundingClientRect().width;
    canvas.height = canvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fontSizeConstant = Math.min(canvas.width, canvas.height) * 0.05;
    const fontSize = fontSizeConstant * ZOOM_COEFF;

    // thanks claude for these mappings/conversion code
    const depts = [...new Set(nodes.map(n => (n.name.match(/[A-Z]{4}/)||["?"])[0]))];
    const hueOf = Object.fromEntries(depts.map((d, i) => [d, (i * 137.508) % 360]));
    const deptObj = Object.fromEntries(depts.map((d) => [d, `hsla(${hueOf[d]}, 70%, 50%, 0.1)`]));

    // cute backgrounds
    latestTree.drawCells(ctx, deptObj);

    // edges — each stroked on its own path so the per-edge colour actually applies
    ctx.lineWidth = 3.0*ZOOM_COEFF;
    for (const edge of edges.filter((e) => (focusedNode !== null && (focusedNode === e[0] || focusedNode === e[1])))) {
        ctx.strokeStyle = "black";
        ctx.beginPath();
        ctx.moveTo(nodes[edge[0]].x*ZOOM_COEFF+OFFSET_X, nodes[edge[0]].y*ZOOM_COEFF+OFFSET_Y);
        ctx.lineTo(nodes[edge[1]].x*ZOOM_COEFF+OFFSET_X, nodes[edge[1]].y*ZOOM_COEFF+OFFSET_Y);
        ctx.stroke();
    }
    ctx.lineWidth = 2.0*ZOOM_COEFF;
    for (const edge of edges.filter((e) => !(focusedNode !== null && (focusedNode === e[0] || focusedNode === e[1])))) {
        ctx.strokeStyle = focusedNode !== null ? "#3c3c3cc0" : "black";
        ctx.beginPath();
        ctx.moveTo(nodes[edge[0]].x*ZOOM_COEFF+OFFSET_X, nodes[edge[0]].y*ZOOM_COEFF+OFFSET_Y);
        ctx.lineTo(nodes[edge[1]].x*ZOOM_COEFF+OFFSET_X, nodes[edge[1]].y*ZOOM_COEFF+OFFSET_Y);
        ctx.stroke();
    }

    // nodes
    ctx.strokeStyle = "#3c3c3cc0";
    for (let i=0;i<nodes.length;i++) {
        const node = nodes[i]
        const dimmed = focusedNode !== null && focusedNode !== i && !neighbours[focusedNode].has(i);

        // label background
        ctx.fillStyle = dimmed ? "#ffffff2f" : "#ffffff9f";
        ctx.fillRect(node.x*ZOOM_COEFF+OFFSET_X-(fontSize*0.6*node.name.length * 0.5), node.y*ZOOM_COEFF+OFFSET_Y-fontSize*1.3, fontSize*0.6*node.name.length, fontSize*0.9)

        // label text
        ctx.fillStyle = dimmed ? "#3c3c3cc0" : "black";
        ctx.font = fontSize + "px monospace";
        ctx.fillText(node.name, node.x*ZOOM_COEFF+OFFSET_X-(fontSize*0.6*node.name.length * 0.5), node.y*ZOOM_COEFF+OFFSET_Y-fontSize*0.5)

        // dot — its own path so the per-node colour applies (a batched fill = one colour for every dot)
        ctx.beginPath();
        ctx.fillStyle = dimmed ? "#3c3c3cc0" : "black";
        ctx.arc(node.x*ZOOM_COEFF+OFFSET_X, node.y*ZOOM_COEFF+OFFSET_Y, RADIUS*ZOOM_COEFF, 0, 2*Math.PI);
        ctx.fill();
    }

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

function selectCourse(course) {
    const courseElem = document.querySelector("#course");
    const pillsElem = document.querySelector(".pills");
    const prereqsElem = document.querySelector("#prereqs");
    const coreqsElem = document.querySelector("#coreqs");
    const retrictionsElem = document.querySelector("#restrictions");
    const descElem = document.querySelector("#description");

    courseElem.textContent = course.id + ": " + course.name;
    descElem.textContent = course.description;
    pillsElem.replaceChildren();
    for (const item of course.instructors.concat(course.semesters).filter(Boolean)) {
        const elem = document.createElement("li");
        elem.textContent = item;
        console.log(item)
        pillsElem.appendChild(elem);
    }
    prereqsElem.textContent = course.prereqsText;
    coreqsElem.textContent = course.coreqsText;
    retrictionsElem.textContent = course.restrictionsText;
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
        this.depts = {};
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
            if (this.body === null) return;
            this.charge = this.body.charge;
            this.cocX = this.body.x;
            this.cocY = this.body.y;
            const dept = (this.body.name.match(/[A-Z]{4}/) || ["?"])[0];
            this.depts = { [dept]: 1 };
            return this.body.charge;
        }

        this.charge = this.cocX = this.cocY = 0;

        let tempX = 0, tempY = 0;
        for (const child of this.children) {
            child.precomputeCharges();
            if (child.charge === 0) continue;
            this.charge += child.charge;
            this.cocX += child.cocX * child.charge;
            this.cocY += child.cocY * child.charge;
            this.depts = Object.entries(this.depts).reduce((acc, [key, value]) => {
                acc[key] = (acc[key] || 0) + value;
                return acc;
            }, { ...child.depts });
        }

        if (this.charge === 0) { this.cocX = this.cocY = 0; return this; }

        this.cocX /= this.charge;
        this.cocY /= this.charge;

        return this;
    }

    computeForceOn(node) {
        if (this.children.length === 0 && (this.body === null || this.body === node)) return [0, 0];

        const k_c = 600_000; //Math.pow(4 * Math.PI * 8.8541878128, -1) * Math.pow(10, 2);

        const dx = this.cocX - node.x;
        const dy = this.cocY - node.y;
        const d_squared = dx*dx + dy*dy;
        
        if (this.children.length === 0 || this.side / Math.sqrt(d_squared) < 0.9) {
            // coulomb for a single point!
            const magnitude = k_c * this.charge * node.charge * 1/Math.max(d_squared, 10000);
            const direction = Math.atan2(node.y - this.cocY, node.x - this.cocX);
            return [magnitude*Math.cos(direction), magnitude*Math.sin(direction)];
        } 

        // too close!
        return this.children.reduce((total_force, cell) => {
            const force = cell.computeForceOn(node);
            return [total_force[0] + force[0], total_force[1] + force[1]]
        }, [0, 0]);
    }

    drawCells(ctx, deptColorMapping) {
        if (this.children.length === 0 && this.body === null) return;
        const x = this.rootX*ZOOM_COEFF + OFFSET_X;
        const y = this.rootY*ZOOM_COEFF + OFFSET_Y;
        const s = this.side*ZOOM_COEFF;

        const dept = Object.entries(this.depts).reduce(
            (prev, curr) => curr[1] > prev[1] ? curr : prev,
            ["?", 0]
        )[0];

        ctx.fillStyle = deptColorMapping[dept] || "transparent";
        ctx.fillRect(x, y, s, s);
        for (const c of this.children) c.drawCells(ctx, deptColorMapping);
    }
}

function update(nodes, edges, neighbours, real_timedelta, stopped = false, alpha = 1, damping = 0.7) {
    const k_s_base = 3; //200;
    // debugger;

    const quadtree = new Cell()
        .build_bounding_box(nodes)
        .insert(nodes)
        .precomputeCharges();
    latestTree = quadtree;

    for (let i=0; i<nodes.length; i++) {
        const dt = Math.min(0.05, real_timedelta);
        // console.log("dt", dt)

        if (nodes[i].fixed && cursor.x !== null && cursor.y !== null) {
            nodes[i].vx = (cursor.x - nodes[i].x) / dt * 0.5;
            nodes[i].vy = (cursor.y - nodes[i].y) / dt * 0.5;
            nodes[i].x = cursor.x;
            nodes[i].y = cursor.y;
            continue;
        }

        if (stopped) continue;

        let SFx = 0, SFy = 0;

        // repulsion: coulomb's law
        let [dFx, dFy] = quadtree.computeForceOn(nodes[i]);
        SFx += dFx;
        SFy += dFy;

        // now check if testF and dF are close to each other, then apply dF to SF

        // attraction: hooke's law
        neighbours[i].forEach((edgeNode) => {
            const k_s = focusedNode === edgeNode ? k_s_base * 5 : k_s_base;
            const magnitude = k_s * _2d_euclidian_distance(nodes[i], nodes[edgeNode]);
            if (magnitude < 0.001) return;
            const direction = Math.atan2(nodes[edgeNode].y - nodes[i].y, nodes[edgeNode].x - nodes[i].x);
            SFx += magnitude * Math.cos(direction);
            SFy += magnitude * Math.sin(direction);
        });

        if (neighbours[i].size === 0 && SFx*SFx + SFy*SFy < 5) {
            nodes[i].vx = 0;
            nodes[i].vy = 0;
            continue;
        }

        const a_x = SFx / nodes[i].mass;
        const a_y = SFy / nodes[i].mass;

        nodes[i].vx += a_x * dt * alpha;
        nodes[i].vy += a_y * dt * alpha;

        nodes[i].vx *= damping;
        nodes[i].vy *= damping;
        
        nodes[i].x += nodes[i].vx * dt;
        nodes[i].y += nodes[i].vy * dt;
    }
}

async function populate() {
    const h = Math.min(canvas.width, canvas.height);
    const courses = await fetchCourses();
    console.log(courses);

    nodeNameToIndexMap = courses.map((c) => c.id);
    const nodeCount = nodeNameToIndexMap.length;
    let neighbours = {};

    const edges = courses.reduce((prev, curr, index) => {
        for (const prereq of curr.prereqs) {
            const from = nodeNameToIndexMap.indexOf(curr.id);
            const to = nodeNameToIndexMap.indexOf(prereq);
            if (to === -1) continue;
            prev.push([from, to]);
        }
        return prev;
    }, []);

    let nodes, data;

    if ((data = localStorage.getItem(urlHash + "_n")) !== null && JSON.parse(data).expiry > new Date().getTime()) {
        nodes = JSON.parse(data).nodes
        neighbours = nodes.map((_, i) => new Set(edges.filter((e) => e.includes(i)).flat().filter(n => n !== i)));
    } else {
        nodes = nodeNameToIndexMap.map((courseid, i) => {
            let res = {};
            res.name = courseid;
            res.fixed = false;
            res.course = courses.find((c) => c.id === courseid);
            res.charge = 10; // constant for now
            res.mass = 5; // same as above
            // res.x = h*Math.cos(2*Math.PI/nodeCount*(i+1));
            // res.y = h*Math.sin(2*Math.PI/nodeCount*(i+1));
            res.vx = 0;
            res.vy = 0;
            res.x = (Math.random() - 0.5) * h * 4;
            res.y = (Math.random() - 0.5) * h * 4;
            neighbours[i] = new Set(edges.filter((e) => e.includes(i)).flat().filter(n => n !== i));
            return res;
        });
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

    let i = 0;
    let alpha = 1;
    let quietFrames;
    function animate(timestamp) {
        const real_timedelta = timestamp - zero;
        if (!settled) {
            alpha *= 1 - 0.0001;
            for (let s = 0; s < 6; s++) update(nodes, edges, neighbours, real_timedelta, false, alpha);
            let ke = totalKE(nodes);
            console.log(i++, ke, alpha);
            if ((nodes.length >= 500 && (alpha < 0.0000001 || ke < 0.001 * nodes.length)) || stopNDump) {   // scale epsilon by node count
                quietFrames = (quietFrames || 0) + 1;
                if (quietFrames > 30) { // stable for ~30 frames → stop
                    settled = true;
                    console.log(neighbours);
                    localStorage.setItem(urlHash + "_n", JSON.stringify({ nodes, expiry }))
                }
            } else quietFrames = 0;
        } else {
            update(nodes, edges, neighbours, real_timedelta, true);
        }
        console.log(neighbours)
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

    let mouseDownMoment, potentiallyClickedNode;
    canvas.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return; // we want left clicks only
        mouseDownMoment = document.timeline.currentTime;
        potentiallyClickedNode = null;

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
        const wasClick = !dragging;        // stayed inside the dead zone → a click, not a pan/drag
        mouseDown = false;

        // release a dragged node, if there was one
        if (fixedNode !== null) {
            nodes[fixedNode].fixed = false;
            fixedNode = null;
            cursor.x = null;
            cursor.y = null;
        }

        if (!wasClick) return;             // it was a pan or node-drag — leave focus alone

        if (potentiallyClickedNode !== null && potentiallyClickedNode !== focusedNode) {
            // clicked a new node → focus it + open the panel
            focusedNode = potentiallyClickedNode;
            nodes[focusedNode].charge = 1;
            nodes[focusedNode].k = 1;
            nodes[focusedNode].mass = 0.1;
            selectCourse(nodes[focusedNode].course);
        } else if (focusedNode !== null) {
            // clicked empty space (or the focused node again) → deselect
            nodes[focusedNode].charge = 10;
            nodes[focusedNode].k = 1;
            nodes[focusedNode].mass = 5;
            focusedNode = null;
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
}
initiate();
