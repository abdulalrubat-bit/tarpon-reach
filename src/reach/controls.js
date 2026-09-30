"use strict";
var Reach;
(function (Reach) {
    function createControls(scene, context) {
        const canvas = document.createElement('canvas');
        canvas.id = 'touch-overlay';
        canvas.setAttribute('aria-hidden', 'true');
        Object.assign(canvas.style, { position: 'fixed', inset: '0', zIndex: '6', pointerEvents: 'none' });
        document.body.appendChild(canvas);
        const graphics = canvas.getContext('2d');
        const abort = new AbortController();
        const listenerOptions = { signal: abort.signal };
        const keys = new Set();
        const state = { pitch: 0, yaw: 0, throttle: 0, firing: false, boost: false };
        const zone = { fire: { x: 0, y: 0, r: 41 }, thr: { x: 0, y0: 0, y1: 1, w: 14 }, stickArea: { x0: 0, x1: 0, y0: 0, y1: 0 } };
        let width = 1;
        let height = 1;
        let ratio = 1;
        let sensitivity = 0.8;
        let stick = -1;
        let trigger = -1;
        let throttle = -1;
        let boostPointer = -1;
        let baseX = 0;
        let baseY = 0;
        let thumbX = 0;
        let thumbY = 0;
        let tapTime = 0;
        let moved = 0;
        const lookPointers = new Map();
        const cameraButton = document.getElementById('camera-control');
        const cameraHint = document.getElementById('camera-hint');
        function cameraUI() {
            const free = scene.cameraRig?.mode === 'orbit';
            cameraButton?.setAttribute('aria-pressed', String(free));
            if (cameraHint)
                cameraHint.textContent = free ? 'FREE LOOK · PINCH TO ZOOM' : 'DRAG SPACE TO LOOK';
        }
        function recenter() { lookPointers.clear(); scene.cameraRig.recenter(); cameraUI(); }
        function cameraMove(event) {
            const pointer = lookPointers.get(event.pointerId);
            if (!pointer)
                return false;
            const points = Array.from(lookPointers.values());
            if (points.length === 2) {
                const oldX = (points[0].x + points[1].x) / 2, oldY = (points[0].y + points[1].y) / 2;
                const before = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                pointer.x = event.clientX;
                pointer.y = event.clientY;
                const after = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                scene.cameraRig.orbit((points[0].x + points[1].x) / 2 - oldX, (points[0].y + points[1].y) / 2 - oldY, Math.min(width, height));
                if (before > 12 && after > 12)
                    scene.cameraRig.zoom(before / after);
                points.forEach((point) => { point.dragged = true; });
            }
            else {
                const movement = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
                if (pointer.dragged || movement > 6) {
                    scene.cameraRig.orbit(event.clientX - pointer.x, event.clientY - pointer.y, Math.min(width, height));
                    pointer.dragged = true;
                }
                pointer.x = event.clientX;
                pointer.y = event.clientY;
            }
            cameraUI();
            return true;
        }
        try {
            sensitivity = Reach.clamp(Number(localStorage.getItem('se.sens')) || 0.8, 0.4, 1.6);
        }
        catch {
            sensitivity = 0.8;
        }
        function reset(stop = false) { state.pitch = state.yaw = 0; state.firing = state.boost = false; stick = trigger = throttle = boostPointer = -1; lookPointers.clear(); keys.clear(); if (stop)
            state.throttle = 0; }
        function layout() {
            width = innerWidth;
            height = innerHeight;
            ratio = Math.min(2, devicePixelRatio || 1);
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';
            zone.fire = { x: width - 92, y: height - 122, r: 41 };
            zone.thr = { x: width - 25, y0: Math.max(156, height - 260), y1: Math.max(241, height - 65), w: 14 };
            zone.stickArea = { x0: 0, x1: width * 0.45, y0: Math.max(152, height * 0.40), y1: height - 45 };
            reset();
        }
        function blocked(target) { return !!scene.director?.paused || !!(target instanceof Element && target.closest('button,input,select,a,[role=dialog],#title-screen')); }
        function setThrottle(y) { state.throttle = Reach.clamp(1 - (y - zone.thr.y0) / Math.max(1, zone.thr.y1 - zone.thr.y0), 0, 1); }
        function down(event) {
            if (blocked(event.target) || event.button > 0)
                return;
            const x = event.clientX;
            const y = event.clientY;
            if (distance2(x, y, zone.fire.x, zone.fire.y) <= zone.fire.r + 8 && trigger < 0) {
                trigger = event.pointerId;
                state.firing = true;
                return;
            }
            if (Math.abs(x - zone.thr.x) < 23 && y > zone.thr.y0 - 15 && y < zone.thr.y1 + 15 && throttle < 0) {
                throttle = event.pointerId;
                setThrottle(y);
                return;
            }
            // The radar's generous altitude hit region overlaps the top of the
            // visible slider. Explicit flight controls take precedence there.
            if (context.radarTap(x, y))
                return;
            if ((scene.cameraRig.mode === 'orbit' ? distance2(x, y, 81, height - 122) < 62 : x < zone.stickArea.x1 && y > zone.stickArea.y0 && y < zone.stickArea.y1) && stick < 0) {
                stick = event.pointerId;
                baseX = thumbX = x;
                baseY = thumbY = y;
                tapTime = performance.now();
                moved = 0;
            }
            else if (lookPointers.size < 2) {
                lookPointers.set(event.pointerId, { x, y, startX: x, startY: y, at: performance.now(), dragged: false });
                if (lookPointers.size === 2)
                    lookPointers.forEach((point) => { point.dragged = true; });
                if (event.target instanceof HTMLElement) {
                    try {
                        event.target.setPointerCapture(event.pointerId);
                    }
                    catch { /* Synthetic pointers and interrupted surfaces may have no capture owner. */ }
                }
            }
        }
        function distance2(x, y, ox, oy) { return Math.hypot(x - ox, y - oy); }
        function move(event) {
            if (event.pointerId === throttle) {
                setThrottle(event.clientY);
                return;
            }
            if (cameraMove(event))
                return;
            if (event.pointerId !== stick)
                return;
            const dx = event.clientX - baseX;
            const dy = event.clientY - baseY;
            const length = Math.hypot(dx, dy);
            moved = Math.max(moved, length);
            const radius = 48;
            const scale = Math.min(1, radius / Math.max(0.001, length));
            thumbX = baseX + dx * scale;
            thumbY = baseY + dy * scale;
            const magnitude = Math.min(1, length / radius);
            const dead = 0.09;
            if (magnitude < dead) {
                state.yaw = state.pitch = 0;
                return;
            }
            const response = (magnitude - dead) / (1 - dead);
            const curve = response * (0.42 + 0.58 * response * response) * sensitivity;
            state.yaw = dx / Math.max(0.001, length) * curve;
            state.pitch = dy / Math.max(0.001, length) * curve;
        }
        function release(event) {
            const intentional = event.type === 'pointerup';
            if (event.pointerId === stick) {
                if (intentional && moved < 8 && performance.now() - tapTime < 300)
                    context.viewTap(event.clientX, event.clientY);
                stick = -1;
                state.pitch = state.yaw = 0;
            }
            const look = lookPointers.get(event.pointerId);
            if (look) {
                if (intentional && !look.dragged && performance.now() - look.at < 300)
                    context.viewTap(event.clientX, event.clientY);
                lookPointers.delete(event.pointerId);
            }
            if (event.pointerId === trigger) {
                trigger = -1;
                state.firing = false;
            }
            if (event.pointerId === throttle)
                throttle = -1;
            if (event.pointerId === boostPointer) {
                boostPointer = -1;
                state.boost = false;
            }
        }
        window.addEventListener('pointerdown', down, listenerOptions);
        window.addEventListener('pointermove', move, listenerOptions);
        window.addEventListener('pointerup', release, listenerOptions);
        window.addEventListener('pointercancel', release, listenerOptions);
        window.addEventListener('lostpointercapture', (event) => { lookPointers.delete(event.pointerId); }, listenerOptions);
        cameraButton?.addEventListener('click', () => { if (scene.director?.paused)
            return; if (scene.cameraRig.mode === 'orbit')
            recenter();
        else {
            scene.cameraRig.beginOrbit();
            cameraUI();
        } }, listenerOptions);
        document.getElementById('camera-home')?.addEventListener('click', () => { if (!scene.director?.paused)
            recenter(); }, listenerOptions);
        document.getElementById('camera-in')?.addEventListener('click', () => { if (!scene.director?.paused)
            scene.cameraRig.zoom(0.82); }, listenerOptions);
        document.getElementById('camera-out')?.addEventListener('click', () => { if (!scene.director?.paused)
            scene.cameraRig.zoom(1 / 0.82); }, listenerOptions);
        window.addEventListener('wheel', (event) => { if (blocked(event.target))
            return; event.preventDefault(); scene.cameraRig.zoom(Math.exp(Reach.clamp(event.deltaY, -200, 200) * 0.002)); }, { ...listenerOptions, passive: false });
        window.addEventListener('blur', () => reset(), listenerOptions);
        window.addEventListener('resize', layout, listenerOptions);
        document.addEventListener('visibilitychange', () => { if (document.hidden)
            reset(); }, listenerOptions);
        const boost = document.getElementById('boost-control');
        boost?.addEventListener('pointerdown', (event) => { if (scene.director?.paused)
            return; event.preventDefault(); boostPointer = event.pointerId; state.boost = true; boost.setPointerCapture(event.pointerId); }, listenerOptions);
        boost?.addEventListener('lostpointercapture', () => { boostPointer = -1; state.boost = false; }, listenerOptions);
        const validKeys = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyC']);
        window.addEventListener('keydown', (event) => { if (!validKeys.has(event.code) || blocked(event.target))
            return; event.preventDefault(); if (event.code === 'KeyC') {
            if (!event.repeat)
                recenter();
            return;
        } keys.add(event.code); }, listenerOptions);
        window.addEventListener('keyup', (event) => { keys.delete(event.code); }, listenerOptions);
        function readKeys(dt) {
            if (scene.director?.paused) {
                reset();
                return;
            }
            if (stick < 0) {
                state.yaw = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
                state.pitch = Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'));
            }
            if (keys.has('KeyE'))
                state.throttle = Math.min(1, state.throttle + dt * 0.65);
            if (keys.has('KeyQ'))
                state.throttle = Math.max(0, state.throttle - dt * 0.85);
            state.firing = trigger >= 0 || keys.has('Space');
            state.boost = boostPointer >= 0 || keys.has('ShiftLeft') || keys.has('ShiftRight');
        }
        function circle(x, y, radius, colour, fill) {
            graphics.beginPath();
            graphics.arc(x, y, radius, 0, Math.PI * 2);
            graphics.strokeStyle = colour;
            graphics.lineWidth = 1;
            graphics.stroke();
            if (fill) {
                graphics.fillStyle = fill;
                graphics.fill();
            }
        }
        function draw() {
            graphics.setTransform(ratio, 0, 0, ratio, 0, 0);
            graphics.clearRect(0, 0, width, height);
            if (scene.director?.paused || scene.loading)
                return;
            const x = stick < 0 ? 81 : baseX;
            const y = stick < 0 ? height - 122 : baseY;
            circle(x, y, 48, stick < 0 ? '#83b9cc70' : '#a4ddea', '#0d2032a0');
            circle(x, y, 38, '#83b9cc25');
            // Small cardinal marks clarify the thumb travel boundary without adding DOM hit regions.
            graphics.strokeStyle = '#94c2d370';
            graphics.beginPath();
            for (let tick = 0; tick < 4; tick++) {
                const angle = tick * Math.PI / 2;
                graphics.moveTo(x + Math.cos(angle) * 43, y + Math.sin(angle) * 43);
                graphics.lineTo(x + Math.cos(angle) * 48, y + Math.sin(angle) * 48);
            }
            graphics.stroke();
            circle(stick < 0 ? x : thumbX, stick < 0 ? y : thumbY, stick < 0 ? 13 : 20, '#b0dbe8b0', '#355b7190');
            const f = zone.fire;
            circle(f.x, f.y, f.r, state.firing ? '#edb77aff' : '#a3b6bf88', state.firing ? '#edb77a30' : '#0c192799');
            circle(f.x, f.y, f.r - 6, '#94aaba22');
            circle(f.x, f.y, 10, state.firing ? '#ffd7a4' : '#bccbd2aa');
            graphics.strokeStyle = state.firing ? '#ffd7a4' : '#bccbd299';
            graphics.beginPath();
            for (let i = 0; i < 4; i++) {
                const angle = Math.PI / 2 * i;
                graphics.moveTo(f.x + Math.cos(angle) * 15, f.y + Math.sin(angle) * 15);
                graphics.lineTo(f.x + Math.cos(angle) * 22, f.y + Math.sin(angle) * 22);
            }
            graphics.stroke();
            const t = zone.thr;
            const size = t.y1 - t.y0;
            graphics.fillStyle = '#0a1724bb';
            graphics.fillRect(t.x - 7, t.y0, 14, size);
            graphics.strokeStyle = '#6f8e9d70';
            graphics.strokeRect(t.x - 7, t.y0, 14, size);
            graphics.fillStyle = '#a5ccce65';
            graphics.fillRect(t.x - 4, t.y1 - size * state.throttle, 8, size * state.throttle);
            graphics.strokeStyle = '#87b8cb65';
            graphics.beginPath();
            for (let tick = 0; tick <= 4; tick++) {
                const y = t.y0 + size * tick / 4;
                graphics.moveTo(t.x - 8, y);
                graphics.lineTo(t.x - 12, y);
            }
            graphics.stroke();
            const marker = t.y1 - size * state.throttle;
            graphics.fillStyle = '#edb77a';
            graphics.fillRect(t.x - 11, marker - 2, 22, 4);
            graphics.font = '8px monospace';
            graphics.textAlign = 'center';
            graphics.fillStyle = '#a8c2cf';
            graphics.fillText('THR', t.x, t.y0 - 10);
        }
        layout();
        return { state, zone, reset, draw, readKeys, get sens() { return sensitivity; }, set sens(value) { sensitivity = Reach.clamp(value, 0.4, 1.6); try {
                localStorage.setItem('se.sens', String(sensitivity));
            }
            catch { /* In-memory control settings remain usable when storage is unavailable. */ } },
            destroy() { abort.abort(); reset(); canvas.remove(); } };
    }
    Reach.createControls = createControls;
})(Reach || (Reach = {}));
SE.Controls = Reach.createControls;
